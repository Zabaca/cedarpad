import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, migrationFiles, applyMigrations, type TestD1 } from "../lib/db/test-d1.js";
import type { Bindings } from "./context.js";
import { buildApp } from "./index.js";
import { resolveActiveWorkspace } from "./middleware.js";

/**
 * Notebook workspace scoping (#57): Observation/Problem `workspace_id` is the
 * PLATFORM workspace (cs_workspace / x-workspace-id), records are isolated per
 * workspace (A never sees B), and legacy rows backfill to `default`.
 */

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: "any", // enables the dev hatch (x-dev-workspace picks the ws)
} as unknown as Bindings;

/** A problem row. No embedding: `vector32()` is libSQL-only and D1 rejects it. */
async function seedProblem(db: Database, id: string, workspaceId: string, body: string) {
  await db.insert(schema.problems).values({ id, workspaceId, title: id, body });
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

/*
 * Three tests were NOT ported onto the D1 seam (CEDA-5U8J2H) — "create persists the
 * active platform workspace_id", "list is scoped to the active workspace" and "search
 * (graph) returns only the active workspace's problems". All three went through the
 * libSQL vector path (`vector32()` on observation create, `vector_distance_cos()` in
 * graph search), which D1 does not have, so what they asserted has been dead in
 * production since the D1 cutover. The workspace-scoping guarantee is re-asserted on
 * the rewritten write path and on FTS5 search (CEDA-CUAS8S, CEDA-1XTYA5).
 */

describe("Notebook isolation end-to-end (#57)", () => {
  let testDb: TestD1;
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
    testDb = await createTestD1();
    db = testDb.db;
    app = buildApp({ db });

    // Two problems with the SAME topic in DIFFERENT platform workspaces.
    const body = "Database connection pool is exhausted under load causing 500s";
    await seedProblem(db, "prob_A", "wsA", body);
    await seedProblem(db, "prob_B", "wsB", body);
  });

  afterAll(() => testDb.dispose());

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

    const { db, d1, dispose } = await createTestD1({ migrations: schemaOnly });

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

    await applyMigrations(d1, [backfill]);

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
    await dispose();
  });
});
