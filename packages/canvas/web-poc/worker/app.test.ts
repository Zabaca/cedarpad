import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHashEmbedder } from "../lib/ai/index.js";
import { configuration } from "../lib/config/index.js";
import { makeDb, schema } from "../lib/db/index.js";
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createGraphToolDeps } from "./agent.js";
import { createAuth } from "./auth.js";
import type { Bindings } from "./context.js";
import { buildApp } from "./index.js";
import { drainAgentJobs } from "./worker.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../lib/db/migrations", import.meta.url).href,
);

/** Every migration's statements, in order — mirrors what the real migrator applies. */
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean),
    );
}

const WORKSPACE = "ws_test";

const env = {
  TURSO_URL: ":memory:",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: WORKSPACE,
} as Record<string, string>;

const client = createClient({ url: ":memory:" });
const db = makeDb(client);
const app = buildApp({ db });
const embedder = createHashEmbedder(configuration.ai.embeddingDimensions);

/** Intake is async now — run the worker inline to process whatever was enqueued. */
const drain = () => drainAgentJobs(db, env as unknown as Bindings);

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
  for (const stmt of migrationStatements()) {
    await client.execute(stmt);
  }

  await db.insert(schema.workspace).values([
    { id: WORKSPACE, name: "Test Workspace", slug: "test-workspace" },
    { id: "ws_other", name: "Other Workspace", slug: "other-workspace" },
  ]);

  // Seed an existing problem WITH an embedding so retrieval has something to find.
  const seedBody = "Database connection pool is exhausted under load causing 500s";
  await db.insert(schema.problems).values({
    id: "prob_seed",
    workspaceId: WORKSPACE,
    title: "Connection pool exhausted",
    body: seedBody,
    embedding: await embedder.embed(`Connection pool exhausted\n\n${seedBody}`),
    embeddingModel: embedder.model,
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

describe("POST /v1/problems (intake + agent pipeline)", () => {
  it("links a near-duplicate to the seed and reuses its solution", async () => {
    const res = await req("/v1/problems", {
      method: "POST",
      body: JSON.stringify({
        title: "Connection pool exhausted",
        body: "Database connection pool is exhausted under load causing 500s",
      }),
    });
    expect(res.status).toBe(201);
    const { problem } = (await res.json()) as { problem: { id: string } };

    // Intake is async: process the queue, then re-read the now-enriched problem.
    await drain();
    const detail = (await (await req(`/v1/problems/${problem.id}`)).json()) as {
      links: { link: { kind: string } }[];
      solutions: { origin: string }[];
      latestRun: { status: string };
    };

    // The agent found the seed and linked it as identical (deterministic hash embedder).
    expect(detail.links.length).toBeGreaterThan(0);
    const kinds = detail.links.map((l) => l.link.kind);
    expect(kinds).toContain("identical");
    // A solution was produced, reusing the seed's solution.
    expect(detail.solutions.length).toBeGreaterThan(0);
    expect(detail.solutions[0]!.origin).toBe("reused");
    expect(detail.latestRun.status).toBe("completed");
  });

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

describe("observations", () => {
  it("creates, lists and reads an observation", async () => {
    const created = (await (
      await req("/v1/observations", {
        method: "POST",
        body: JSON.stringify({
          title: "Slow page on mobile",
          body: "A user said the dashboard took ages on their phone.",
          projectTags: ["Mobile"],
          runAgent: false,
        }),
      })
    ).json()) as { observation: { id: string; projectTags: string[] } };
    expect(created.observation.projectTags).toEqual(["Mobile"]);

    const list = (await (await req("/v1/observations")).json()) as { items: { id: string }[]; total: number };
    expect(list.items.some((o) => o.id === created.observation.id)).toBe(true);

    const tags = (await (await req("/v1/project-tags")).json()) as { tags: string[] };
    expect(tags.tags).toContain("Mobile");
  });
});

describe("POST /v1/problems/synthesize", () => {
  it("synthesizes a problem from observations and links them", async () => {
    const mkObs = (title: string, body: string) =>
      req("/v1/observations", {
        method: "POST",
        body: JSON.stringify({ title, body, runAgent: false }),
      }).then((r) => r.json()) as Promise<{ observation: { id: string } }>;
    const o1 = await mkObs("Timeout at checkout", "checkout timed out for a user at 9am");
    const o2 = await mkObs("Another checkout hang", "checkout spun and failed during a demo");

    const res = await req("/v1/problems/synthesize", {
      method: "POST",
      body: JSON.stringify({
        observationIds: [o1.observation.id, o2.observation.id],
        title: "Checkout intermittently hangs",
      }),
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    // Synthesis runs in the worker; drain it, then read the problem it created.
    await drain();
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, jobId));
    const problemId = (job!.result as { problemId: string }).problemId;
    const detail = (await (await req(`/v1/problems/${problemId}`)).json()) as {
      problem: { title: string; source: string };
      sourceObservations: { id: string }[];
    };
    expect(detail.problem.title).toBe("Checkout intermittently hangs");
    expect(detail.sourceObservations.map((o) => o.id).sort()).toEqual(
      [o1.observation.id, o2.observation.id].sort(),
    );
  });

  it("404s when an observation is not in the workspace", async () => {
    const res = await req("/v1/problems/synthesize", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_nope"] }),
    });
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
  it("searchGraph returns ranked hits annotated with solution signals", async () => {
    const res = await req(`/v1/graph/search?q=${encodeURIComponent("connection pool exhausted")}`);
    expect(res.status).toBe(200);
    const results = (await res.json()) as { id: string; hasAcceptedSolution: boolean }[];
    expect(results.some((r) => r.id === "prob_seed")).toBe(true);
  });

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

describe("createGraphToolDeps (in-process tool wiring)", () => {
  it("searchGraph tool dep embeds the query and returns annotated hits", async () => {
    const deps = createGraphToolDeps(db, env as unknown as Bindings);
    const results = (await deps.searchGraph({ query: "connection pool exhausted" })) as {
      id: string;
    }[];
    expect(results.some((r) => r.id === "prob_seed")).toBe(true);
  });
});

describe("problems list: pagination, search, solved filter", () => {
  it("paginates, searches and filters by solved", async () => {
    const mk = (title: string, body: string) =>
      req("/v1/problems", {
        method: "POST",
        body: JSON.stringify({ title, body, runAgent: false }),
      });
    await mk("Alpha latency", "checkout latency spike");
    await mk("Beta crash", "null pointer on load");
    await mk("Gamma latency", "search latency high");

    const p1 = (await (await req(`/v1/problems?q=latency&limit=1&offset=0`)).json()) as {
      items: { id: string }[];
      total: number;
    };
    expect(p1.total).toBe(2); // Alpha + Gamma
    expect(p1.items.length).toBe(1);

    const p2 = (await (await req(`/v1/problems?q=latency&limit=1&offset=1`)).json()) as {
      items: unknown[];
    };
    expect(p2.items.length).toBe(1);
  });
});

describe("editing: update problem, reject AI solution, add human solution", () => {
  it("edits a problem, rejects the AI solution (kept intact), adds the human fix", async () => {
    const created = (await (
      await req("/v1/problems", {
        method: "POST",
        body: JSON.stringify({ title: "Edit me", body: "original", runAgent: true }),
      })
    ).json()) as { problem: { id: string } };
    const pid = created.problem.id;

    // Intake is async — process the queue, then read the AI solution it produced.
    await drain();
    const enriched = (await (await req(`/v1/problems/${pid}`)).json()) as {
      solutions: { id: string; body: string }[];
    };
    expect(enriched.solutions.length).toBeGreaterThan(0);
    const aiSolId = enriched.solutions[0]!.id;

    // Edit the problem
    const upd = await req(`/v1/problems/${pid}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Edited title", status: "resolved", urgency: "high" }),
    });
    expect(upd.status).toBe(200);
    const detail = (await upd.json()) as { problem: { title: string; status: string; urgency: string } };
    expect(detail.problem.title).toBe("Edited title");
    expect(detail.problem.status).toBe("resolved");
    expect(detail.problem.urgency).toBe("high");

    // Reject the AI solution — its body must stay intact (for learning)
    const rej = await req(`/v1/solutions/${aiSolId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "rejected" }),
    });
    expect(rej.status).toBe(200);
    const rejSol = (await rej.json()) as { status: string; body: string };
    expect(rejSol.status).toBe("rejected");
    expect(rejSol.body.length).toBeGreaterThan(0);

    // Add the solution that actually worked (human-authored, accepted)
    const add = await req("/v1/solutions", {
      method: "POST",
      body: JSON.stringify({ targetKind: "problem", targetId: pid, body: "The fix that actually worked" }),
    });
    expect(add.status).toBe(201);
    const human = (await add.json()) as { origin: string; status: string };
    expect(human.origin).toBe("human");
    expect(human.status).toBe("accepted");

    // Both coexist: the rejected AI answer + the accepted human one
    const after = (await (await req(`/v1/problems/${pid}`)).json()) as {
      solutions: { status: string; origin: string }[];
    };
    expect(after.solutions.some((s) => s.status === "rejected")).toBe(true);
    expect(after.solutions.some((s) => s.origin === "human" && s.status === "accepted")).toBe(true);
  });

  it("404s editing a problem or solution outside the workspace", async () => {
    expect((await req("/v1/problems/prob_nope", { method: "PATCH", body: JSON.stringify({ title: "x" }) })).status).toBe(404);
    expect((await req("/v1/solutions/sol_nope", { method: "PATCH", body: JSON.stringify({ status: "accepted" }) })).status).toBe(404);
  });
});

describe("GET /v1/problems/:id/cluster-summary (Tier 3)", () => {
  it("returns a deterministic templated summary with no key, then serves it from cache", async () => {
    const first = await req(`/v1/problems/prob_seed/cluster-summary`);
    expect(first.status).toBe(200);
    const a = (await first.json()) as {
      rootProblemId: string;
      summary: string;
      model: string | null;
      memberCount: number;
      cached: boolean;
    };
    expect(a.rootProblemId).toBe("prob_seed");
    expect(a.model).toBe("heuristic"); // no provider key → templated, no LLM
    expect(a.summary).toContain("Connection pool exhausted");
    expect(a.cached).toBe(false); // freshly computed + cached

    const second = await req(`/v1/problems/prob_seed/cluster-summary`);
    const b = (await second.json()) as { summary: string; cached: boolean };
    expect(b.cached).toBe(true); // membership unchanged → cache hit
    expect(b.summary).toBe(a.summary);
  });

  it("404s for an unknown problem", async () => {
    const res = await req(`/v1/problems/prob_missing/cluster-summary`);
    expect(res.status).toBe(404);
  });
});

describe("access model: reads are confined to the active workspace (ADR-0007, #57)", () => {
  it("lists only the active workspace's problems; an out-of-scope ?workspaceId= yields nothing", async () => {
    // Create a problem that lives in ws_other.
    const created = (await (
      await req(
        "/v1/problems",
        { method: "POST", body: JSON.stringify({ title: "Other-ws problem", body: "in ws_other", runAgent: false }) },
        "ws_other",
      )
    ).json()) as { problem: { id: string; workspaceId: string } };
    expect(created.problem.workspaceId).toBe("ws_other");

    // Default list (called as ws_test) never sees ws_other's rows.
    const all = (await (await req("/v1/problems?limit=100")).json()) as {
      items: { workspaceId: string }[];
    };
    const wsIds = new Set(all.items.map((p) => p.workspaceId));
    expect(wsIds.has(WORKSPACE)).toBe(true);
    expect(wsIds.has("ws_other")).toBe(false);

    // An explicit ?workspaceId= outside the caller's scope is forced empty, not honoured.
    const narrowed = (await (await req("/v1/problems?limit=100&workspaceId=ws_other")).json()) as {
      items: { id: string; workspaceId: string }[];
    };
    expect(narrowed.items).toEqual([]);

    // The row exists — its own workspace sees it.
    const own = (await (await req("/v1/problems?limit=100", {}, "ws_other")).json()) as {
      items: { id: string }[];
    };
    expect(own.items.some((p) => p.id === created.problem.id)).toBe(true);
  });

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
