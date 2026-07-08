import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createHashEmbedder } from "../lib/ai/index.js";
import { configuration } from "../lib/config/index.js";
import { type Database, makeDb, schema } from "../lib/db/index.js";
import type { Bindings } from "./context.js";
import { buildApp } from "./index.js";
import { resolveActiveWorkspace } from "./middleware.js";

/**
 * Notebook workspace scoping (#57): Observation/Problem `workspace_id` is the
 * PLATFORM workspace (cs_workspace / x-workspace-id), records are isolated per
 * workspace (A never sees B), and legacy rows backfill to `default`.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../lib/db/migrations", import.meta.url));

/** Parse each migration file into its individual SQL statements, in order. */
function migrationFiles(): { name: string; statements: string[] }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      name: f,
      statements: readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean),
    }));
}

type Client = ReturnType<typeof createClient>;

async function applyMigrations(client: Client, files = migrationFiles()) {
  for (const file of files) for (const stmt of file.statements) await client.execute(stmt);
}

function freshDb() {
  const client = createClient({ url: ":memory:" });
  return { client, db: makeDb(client) };
}

const embedder = createHashEmbedder(configuration.ai.embeddingDimensions);

const env = {
  TURSO_URL: ":memory:",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: "any", // enables the dev hatch (x-dev-workspace picks the ws)
} as unknown as Bindings;

/** A problem row with a deterministic embedding so search can find it. */
async function seedProblem(db: Database, id: string, workspaceId: string, body: string) {
  await db.insert(schema.problems).values({
    id,
    workspaceId,
    title: id,
    body,
    embedding: await embedder.embed(`${id}\n\n${body}`),
    embeddingModel: embedder.model,
  });
}

describe("resolveActiveWorkspace — source resolution (#57)", () => {
  it("session call reads the cs_workspace cookie", () => {
    expect(resolveActiveWorkspace({ isAgent: false, header: "hdr", cookie: "ws_cookie" })).toBe(
      "ws_cookie",
    );
  });
  it("agent call reads the x-workspace-id header", () => {
    expect(resolveActiveWorkspace({ isAgent: true, header: "ws_hdr", cookie: "ws_cookie" })).toBe(
      "ws_hdr",
    );
  });
  it("falls back to `default` when the selection is absent or empty", () => {
    expect(resolveActiveWorkspace({ isAgent: false, header: null, cookie: null })).toBe("default");
    expect(resolveActiveWorkspace({ isAgent: false, header: null, cookie: "" })).toBe("default");
    expect(resolveActiveWorkspace({ isAgent: true, header: undefined, cookie: "x" })).toBe("default");
  });
});

describe("Notebook isolation end-to-end (#57)", () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;

  const call = (path: string, workspace: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: { "content-type": "application/json", "x-dev-workspace": workspace, ...(init.headers ?? {}) },
      },
      env as unknown as Record<string, string>,
    );

  beforeAll(async () => {
    const f = freshDb();
    db = f.db;
    await applyMigrations(f.client);
    app = buildApp({ db });

    // Two problems with the SAME topic in DIFFERENT platform workspaces.
    const body = "Database connection pool is exhausted under load causing 500s";
    await seedProblem(db, "prob_A", "wsA", body);
    await seedProblem(db, "prob_B", "wsB", body);
  });

  it("create persists the active platform workspace_id", async () => {
    const res = await call("/v1/observations", "wsA", {
      method: "POST",
      body: JSON.stringify({ title: "pool obs", body: "connections exhausted" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { observation: { id: string; workspaceId: string } };
    expect(created.observation.workspaceId).toBe("wsA");
    const [row] = await db
      .select({ workspaceId: schema.observations.workspaceId })
      .from(schema.observations)
      .where(eq(schema.observations.id, created.observation.id));
    expect(row.workspaceId).toBe("wsA");
  });

  it("list is scoped to the active workspace (A never sees B)", async () => {
    await call("/v1/observations", "wsB", {
      method: "POST",
      body: JSON.stringify({ title: "B only", body: "belongs to B" }),
    });
    const resA = await call("/v1/observations", "wsA");
    const listA = (await resA.json()) as { items?: { title: string }[] } | { title: string }[];
    const itemsA = Array.isArray(listA) ? listA : (listA.items ?? []);
    expect(itemsA.some((o) => o.title === "B only")).toBe(false);
    expect(itemsA.some((o) => o.title === "pool obs")).toBe(true);
  });

  it("search (graph) returns only the active workspace's problems", async () => {
    const q = encodeURIComponent("connection pool exhausted 500s");
    const resA = await call(`/v1/graph/search?q=${q}`, "wsA");
    expect(resA.status).toBe(200);
    const hitsA = (await resA.json()) as { id: string }[];
    expect(hitsA.some((h) => h.id === "prob_A")).toBe(true);
    expect(hitsA.some((h) => h.id === "prob_B")).toBe(false);

    const resB = await call(`/v1/graph/search?q=${q}`, "wsB");
    const hitsB = (await resB.json()) as { id: string }[];
    expect(hitsB.some((h) => h.id === "prob_B")).toBe(true);
    expect(hitsB.some((h) => h.id === "prob_A")).toBe(false);
  });

  it("cross-workspace detail is a 404 (isolation on reads)", async () => {
    // prob_B exists but is not in wsA's scope.
    const res = await call("/v1/problems/prob_B", "wsA");
    expect(res.status).toBe(404);
  });
});

describe("legacy-row backfill → default (#57 migration 0004)", () => {
  it("rewrites pre-existing observation/problem workspace_id to `default`", async () => {
    const files = migrationFiles();
    const schemaOnly = files.filter((f) => !f.name.startsWith("0004"));
    const backfill = files.find((f) => f.name.startsWith("0004"))!;

    const { client, db } = freshDb();
    await applyMigrations(client, schemaOnly);

    // Rows created under the OLD semantics (workspace_id = a Better Auth org id).
    await db.insert(schema.observations).values({
      id: "obs_legacy",
      workspaceId: "org_legacy_123",
      title: "legacy",
      body: "made before #57",
    });
    await db.insert(schema.problems).values({
      id: "prob_legacy",
      workspaceId: "org_legacy_123",
      title: "legacy",
      body: "made before #57",
    });

    await applyMigrations(client, [backfill]);

    const [obs] = await db
      .select({ w: schema.observations.workspaceId })
      .from(schema.observations)
      .where(eq(schema.observations.id, "obs_legacy"));
    const [prob] = await db
      .select({ w: schema.problems.workspaceId })
      .from(schema.problems)
      .where(and(eq(schema.problems.id, "prob_legacy")));
    expect(obs.w).toBe("default");
    expect(prob.w).toBe("default");
  });
});
