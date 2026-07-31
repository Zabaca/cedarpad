import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.js";
import { buildApp } from "./index.js";

const WORKSPACE = "ws_test";

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: WORKSPACE,
} as Record<string, string>;

// The seam runs on a REAL D1 — workerd's own, via Miniflare — the engine production
// runs on (ADR-0018). See lib/db/test-d1.ts.
let testDb: TestD1;
let db: Database;
let app: ReturnType<typeof buildApp>;

async function req(path: string, init: RequestInit = {}, workspace = WORKSPACE) {
  return app.request(
    path,
    {
      ...init,
      headers: { "content-type": "application/json", "x-dev-workspace": workspace, ...(init.headers ?? {}) },
    },
    env,
  );
}

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });

  await db.insert(schema.workspace).values([
    { id: WORKSPACE, name: "Test Workspace", slug: "test-workspace" },
    { id: "ws_other", name: "Other Workspace", slug: "other-workspace" },
  ]);

  const seedBody = "Database connection pool is exhausted under load causing 500s";
  await db.insert(schema.problems).values({
    id: "prob_seed",
    workspaceId: WORKSPACE,
    title: "Connection pool exhausted",
    body: seedBody,
  });
  // Attach a solution to the seed so the agent can reuse it.
  await db.insert(schema.solutions).values({
    id: "sol_seed",
    body: "Increase the pool size and add connection timeouts.",
    origin: "synthesized",
    status: "accepted",
  });
  await db
    .insert(schema.solutionLinks)
    .values({ solutionId: "sol_seed", targetKind: "problem", targetId: "prob_seed" });
});

afterAll(() => testDb.dispose());

/*
 * Of the eight tests CEDA-5U8J2H could not port onto this seam, the observation
 * ones return here in `worker/observations.test.ts`. The rest were the similarity
 * graph — searchGraph, synthesis, near-duplicate linking, cluster summaries — which
 * ADR-0024 removes outright rather than rebuilds; search returns on FTS5 with
 * CEDA-1XTYA5, and the problem-side coverage with CEDA-XQXS7V.
 */

describe("POST /v1/problems (intake + agent pipeline)", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.request(
      "/v1/problems",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x", body: "y" }),
      },
      { ...env, DEV_AUTH_WORKSPACE: "" },
    );
    expect(res.status).toBe(401);
  });

  it("cannot read a problem from another workspace (isolation, #57)", async () => {
    const res = await req("/v1/problems/prob_seed", {}, "ws_other");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/graph", () => {
  it("returns nodes and edges for the workspace", async () => {
    const res = await req(`/v1/graph`);
    expect(res.status).toBe(200);
    const graph = (await res.json()) as { nodes: { type: string }[]; edges: unknown[] };
    expect(graph.nodes.some((n) => n.type === "problem")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "solution")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
  });
});

describe("agent graph retrieval endpoints", () => {
  it("getProblemContext returns the node, edges and attached solutions", async () => {
    const res = await req(`/v1/problems/prob_seed/context`);
    expect(res.status).toBe(200);
    const ctx = (await res.json()) as {
      problem: { id: string };
      solutions: { id: string }[];
    };
    expect(ctx.problem.id).toBe("prob_seed");
    expect(ctx.solutions.some((s) => s.id === "sol_seed")).toBe(true);
  });

  it("getProblemContext 404s for an unknown problem", async () => {
    const res = await req(`/v1/problems/prob_missing/context`);
    expect(res.status).toBe(404);
  });

  it("neighborhood returns a bounded subgraph rooted at the problem", async () => {
    const res = await req(`/v1/problems/prob_seed/neighborhood`);
    expect(res.status).toBe(200);
    const nb = (await res.json()) as { rootId: string; nodes: { id: string; depth: number }[] };
    expect(nb.rootId).toBe("prob_seed");
    expect(nb.nodes.find((n) => n.id === "prob_seed")?.depth).toBe(0);
  });

  it("solved-neighbors returns an array", async () => {
    const res = await req(`/v1/problems/prob_seed/solved-neighbors`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("editing: update problem, reject AI solution, add human solution", () => {
  it("404s editing a problem or solution outside the workspace", async () => {
    expect((await req("/v1/problems/prob_nope", { method: "PATCH", body: JSON.stringify({ title: "x" }) })).status).toBe(404);
    expect((await req("/v1/solutions/sol_nope", { method: "PATCH", body: JSON.stringify({ status: "accepted" }) })).status).toBe(404);
  });
});

describe("access model: reads are confined to the active workspace (ADR-0007, #57)", () => {
  it("GET /v1/workspaces returns only the active workspace", async () => {
    const res = await req("/v1/workspaces");
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map((w) => w.id);
    expect(ids).toContain(WORKSPACE);
    expect(ids).not.toContain("ws_other");
  });

  it("activates the active workspace; any other is a 404, same as an unknown one", async () => {
    const ok = await req(`/v1/workspaces/${WORKSPACE}/activate`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe(WORKSPACE);

    const other = await req("/v1/workspaces/ws_other/activate", { method: "POST" });
    expect(other.status).toBe(404);

    const missing = await req("/v1/workspaces/ws_nope/activate", { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("API keys: shared registry (any user sees/revokes any key)", () => {
  beforeAll(async () => {
    await db.insert(schema.user).values([
      { id: "user_a", name: "Alice", email: "alice@test.dev" },
      { id: "user_b", name: "Bob", email: "bob@test.dev" },
    ]);
    await db.insert(schema.apikey).values([
      {
        id: "key_a",
        key: "hash_a",
        userId: "user_a",
        name: "Alice key",
        start: "cedar_aaa",
        metadata: JSON.stringify({ defaultWorkspaceId: WORKSPACE, allowedWorkspaces: [WORKSPACE] }),
      },
      {
        id: "key_b",
        key: "hash_b",
        userId: "user_b",
        name: "Bob key",
        start: "cedar_bbb",
        metadata: JSON.stringify({ defaultWorkspaceId: "ws_other" }),
      },
    ]);
  });

  it("lists every key with owner + scoping, and never the secret", async () => {
    const res = await req("/v1/api-keys");
    expect(res.status).toBe(200);
    const keys = (await res.json()) as {
      id: string;
      owner: { email: string } | null;
      defaultWorkspaceId: string | null;
      allowedWorkspaces: string[] | null;
    }[];
    const a = keys.find((k) => k.id === "key_a")!;
    const b = keys.find((k) => k.id === "key_b")!;
    // Both owners' keys are visible to the same caller — no admin, no isolation.
    expect(a.owner?.email).toBe("alice@test.dev");
    expect(a.defaultWorkspaceId).toBe(WORKSPACE);
    expect(a.allowedWorkspaces).toEqual([WORKSPACE]);
    expect(b.owner?.email).toBe("bob@test.dev");
    expect(b.allowedWorkspaces).toBeNull(); // no allowlist ⇒ all workspaces
    // The secret column is never selected, so it can't leak.
    expect(JSON.stringify(keys)).not.toContain("hash_");
  });

  it("revokes another user's key (no admin role) and 404s unknown ids", async () => {
    // The caller is not Bob, yet can revoke Bob's key from the shared registry.
    const del = await req("/v1/api-keys/key_b", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { success: boolean }).success).toBe(true);

    const after = (await (await req("/v1/api-keys")).json()) as { id: string }[];
    expect(after.some((k) => k.id === "key_b")).toBe(false);
    expect(after.some((k) => k.id === "key_a")).toBe(true);

    const missing = await req("/v1/api-keys/key_nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  // Regression: the plugin (≥1.6) persists `configId` + `referenceId` + metadata.
  // Our schema maps `referenceId`→`user_id` and adds `config_id`; this exercises
  // the real create path end-to-end (direct row seeding above would not catch it).
  it("mints a key through the Better Auth plugin with workspace metadata", async () => {
    const auth = createAuth(db, env as unknown as Bindings);
    await db.insert(schema.user).values({ id: "user_c", name: "Carol", email: "carol@test.dev" });

    // Server-side create (no session) resolves the owner from `userId` — the same
    // plugin path the web client triggers, against our real Drizzle schema.
    const created = await auth.api.createApiKey({
      body: {
        name: "Carol agent",
        userId: "user_c",
        metadata: { defaultWorkspaceId: WORKSPACE, allowedWorkspaces: [WORKSPACE] },
      },
    });
    expect(created.key).toBeTruthy();

    // It round-trips back through the shared registry with owner + scoping intact.
    const keys = (await (await req("/v1/api-keys")).json()) as {
      id: string;
      owner: { email: string } | null;
      defaultWorkspaceId: string | null;
      allowedWorkspaces: string[] | null;
    }[];
    const mine = keys.find((k) => k.id === created.id)!;
    expect(mine.owner?.email).toBe("carol@test.dev");
    expect(mine.defaultWorkspaceId).toBe(WORKSPACE);
    expect(mine.allowedWorkspaces).toEqual([WORKSPACE]);
  });
});
