import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import type { Bindings } from "./context.js";
import { buildApp } from "./index.js";

/**
 * Solutions and deliberate Problem↔Problem links (ADR-0024), and the workspace
 * scoping both have been missing. Two workspaces are seeded with mirror-image
 * rows; every read is driven from workspace A and must never surface B's.
 *
 * Everything runs through the ONE seam: the Notebook HTTP app on a real D1.
 */

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: "any", // enables the dev hatch (x-dev-workspace picks the ws)
} as unknown as Bindings;

const WS_A = "wsA";
const WS_B = "wsB";

let testDb: TestD1;
let db: Database;
let app: ReturnType<typeof buildApp>;

function call(path: string, workspace: string, init: RequestInit = {}) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-dev-workspace": workspace,
        ...(init.headers ?? {}),
      },
    },
    env as unknown as Record<string, string>,
  );
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });

  await db.insert(schema.problems).values([
    { id: "prob_a1", workspaceId: WS_A, title: "A1", body: "pool exhausted in A" },
    { id: "prob_a2", workspaceId: WS_A, title: "A2", body: "timeouts in A" },
    { id: "prob_b1", workspaceId: WS_B, title: "B1", body: "pool exhausted in B" },
    { id: "prob_b2", workspaceId: WS_B, title: "B2", body: "timeouts in B" },
  ]);
  await db.insert(schema.observations).values([
    { id: "obs_a1", workspaceId: WS_A, title: "obsA", body: "seen in A" },
    { id: "obs_b1", workspaceId: WS_B, title: "obsB", body: "seen in B" },
  ]);
});

afterAll(() => testDb.dispose());

describe("Solutions attach to a Problem or an Observation", () => {
  it("attaches to a problem and reads back from the problem", async () => {
    const created = await call(
      "/v1/solutions",
      WS_A,
      json({ targetKind: "problem", targetId: "prob_a1", body: "Raise the pool size.", origin: "human" }),
    );
    expect(created.status).toBe(201);
    const solution = (await created.json()) as { id: string; body: string; origin: string; status: string };
    expect(solution.body).toBe("Raise the pool size.");
    expect(solution.origin).toBe("human");

    const listed = await call("/v1/solutions?targetKind=problem&targetId=prob_a1", WS_A);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { id: string }[]).map((s) => s.id)).toContain(solution.id);

    const detail = await call("/v1/problems/prob_a1", WS_A);
    const { solutions } = (await detail.json()) as { solutions: { id: string }[] };
    expect(solutions.map((s) => s.id)).toContain(solution.id);
  });

  it("attaches to an observation and reads back from the observation", async () => {
    const created = await call(
      "/v1/solutions",
      WS_A,
      json({
        targetKind: "observation",
        targetId: "obs_a1",
        body: "Restart the sidecar.",
        origin: "research",
      }),
    );
    expect(created.status).toBe(201);
    const solution = (await created.json()) as { id: string };

    const listed = await call("/v1/solutions?targetKind=observation&targetId=obs_a1", WS_A);
    expect(((await listed.json()) as { id: string }[]).map((s) => s.id)).toContain(solution.id);

    const detail = await call("/v1/observations/obs_a1", WS_A);
    const { solutions } = (await detail.json()) as { solutions: { id: string }[] };
    expect(solutions.map((s) => s.id)).toContain(solution.id);
  });
});

describe("Problem links are written deliberately, and can be removed", () => {
  it("links two problems and reads the link back off the problem", async () => {
    const res = await call(
      "/v1/problems/prob_a1/links",
      WS_A,
      json({ toProblemId: "prob_a2", kind: "related", rationale: "Same pool" }),
    );
    expect(res.status).toBe(201);
    const link = (await res.json()) as {
      fromProblemId: string;
      toProblemId: string;
      kind: string;
      rationale: string | null;
      createdBy: string;
    };
    expect(link).toMatchObject({
      fromProblemId: "prob_a1",
      toProblemId: "prob_a2",
      kind: "related",
      rationale: "Same pool",
    });

    const detail = await call("/v1/problems/prob_a1", WS_A);
    const { links } = (await detail.json()) as { links: { problem: { id: string } }[] };
    expect(links.map((l) => l.problem.id)).toEqual(["prob_a2"]);
  });

  it("removes the link, leaving both problems in place", async () => {
    const del = await call("/v1/problems/prob_a1/links/prob_a2", WS_A, { method: "DELETE" });
    expect(del.status).toBe(200);

    const detail = await call("/v1/problems/prob_a1", WS_A);
    const { links } = (await detail.json()) as { links: unknown[] };
    expect(links).toEqual([]);
    expect((await call("/v1/problems/prob_a2", WS_A)).status).toBe(200);

    // Removing a link that is not there is a 404, not a silent success.
    expect((await call("/v1/problems/prob_a1/links/prob_a2", WS_A, { method: "DELETE" })).status).toBe(404);
  });
});

describe("every read takes a workspace and never crosses it", () => {
  it("refuses to link across workspaces, in either direction", async () => {
    const out = await call(
      "/v1/problems/prob_a1/links",
      WS_A,
      json({ toProblemId: "prob_b1", kind: "related" }),
    );
    expect(out.status).toBe(404);

    // ...and A cannot use B's problem as the *source* of a link either.
    const inbound = await call(
      "/v1/problems/prob_b1/links",
      WS_A,
      json({ toProblemId: "prob_a1", kind: "related" }),
    );
    expect(inbound.status).toBe(404);

    const bDetail = await call("/v1/problems/prob_b1", WS_B);
    const { links } = (await bDetail.json()) as { links: unknown[] };
    expect(links).toEqual([]);
  });

  it("a solution cannot be attached to another workspace's problem or observation", async () => {
    const p = await call(
      "/v1/solutions",
      WS_A,
      json({ targetKind: "problem", targetId: "prob_b1", body: "nope", origin: "human" }),
    );
    expect(p.status).toBe(404);
    const o = await call(
      "/v1/solutions",
      WS_A,
      json({ targetKind: "observation", targetId: "obs_b1", body: "nope", origin: "human" }),
    );
    expect(o.status).toBe(404);
  });

  it("problem context 404s across a workspace and never lists a foreign edge", async () => {
    // A link that DOES cross workspaces (seeded directly — the API refuses to
    // write one) must not surface on either side's context read.
    await db.insert(schema.problemLinks).values({
      id: "plink_cross",
      fromProblemId: "prob_a1",
      toProblemId: "prob_b1",
      kind: "related",
      createdBy: "agent",
    });

    expect((await call("/v1/problems/prob_b1/context", WS_A)).status).toBe(404);

    const mine = await call("/v1/problems/prob_a1/context", WS_A);
    expect(mine.status).toBe(200);
    const ctx = (await mine.json()) as { edges: { problemId: string }[] };
    expect(ctx.edges.map((e) => e.problemId)).not.toContain("prob_b1");
  });

  it("neighbourhood 404s across a workspace and never traverses out of it", async () => {
    expect((await call("/v1/problems/prob_b1/neighborhood", WS_A)).status).toBe(404);

    // prob_a1 —(seeded, cross-workspace)→ prob_b1 —(same workspace)→ prob_b2.
    // Neither may appear, at any depth.
    await call("/v1/problems/prob_b1/links", WS_B, json({ toProblemId: "prob_b2", kind: "related" }));

    const res = await call("/v1/problems/prob_a1/neighborhood?hops=3", WS_A);
    expect(res.status).toBe(200);
    const nb = (await res.json()) as {
      nodes: { id: string }[];
      edges: { toProblemId: string }[];
    };
    expect(nb.nodes.map((n) => n.id)).toEqual(["prob_a1"]);
    expect(nb.edges).toEqual([]);
  });

  it("the workspace graph and the item feed return nothing from the other workspace", async () => {
    const graph = await call("/v1/graph", WS_A);
    const g = (await graph.json()) as { nodes: { id: string }[] };
    const gIds = g.nodes.map((n) => n.id);
    expect(gIds).toContain("prob_a1");
    expect(gIds).not.toContain("prob_b1");
    expect(gIds).not.toContain("obs_b1");

    const feed = await call("/v1/items", WS_A);
    const f = (await feed.json()) as { items: { id: string }[] };
    const fIds = f.items.map((i) => i.id);
    expect(fIds).toContain("obs_a1");
    expect(fIds.some((id) => id.endsWith("_b1") || id.endsWith("_b2"))).toBe(false);
  });
});

// The `?solved=true` filter — the same EXISTS-accepted-solution rule the observations
// list, the problems list and the unified feed each apply. It had no coverage before the
// four inline copies were consolidated into `solvedFilter`, so these pin all three
// surfaces: a DRAFT solution must NOT count, only an accepted one.
describe("the `solved` filter surfaces only targets with an accepted solution", () => {
  beforeAll(async () => {
    await db.insert(schema.problems).values([
      { id: "prob_solved", workspaceId: WS_A, title: "PS", body: "carries an accepted solution" },
      { id: "prob_draft", workspaceId: WS_A, title: "PD", body: "only a draft solution" },
    ]);
    await db.insert(schema.observations).values([
      { id: "obs_solved", workspaceId: WS_A, title: "OS", body: "carries an accepted solution" },
    ]);
    await db.insert(schema.solutions).values([
      { id: "sol_ok", body: "the accepted one", origin: "human", status: "accepted" },
      { id: "sol_draft", body: "still a draft", origin: "human", status: "draft" },
    ]);
    await db.insert(schema.solutionLinks).values([
      { solutionId: "sol_ok", targetKind: "problem", targetId: "prob_solved" },
      { solutionId: "sol_ok", targetKind: "observation", targetId: "obs_solved" },
      { solutionId: "sol_draft", targetKind: "problem", targetId: "prob_draft" },
    ]);
  });

  const idsOf = async (res: Response) =>
    ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);

  it("narrows the problems list to accepted-only (a draft solution does not count)", async () => {
    const solved = await idsOf(await call("/v1/problems?solved=true", WS_A));
    expect(solved).toContain("prob_solved");
    expect(solved).not.toContain("prob_draft");
  });

  it("narrows the observations list to accepted-only", async () => {
    const solved = await idsOf(await call("/v1/observations?solved=true", WS_A));
    expect(solved).toContain("obs_solved");
  });

  it("narrows the unified feed the same way across both streams", async () => {
    const solved = await idsOf(await call("/v1/items?solved=true", WS_A));
    expect(solved).toContain("prob_solved");
    expect(solved).toContain("obs_solved");
    expect(solved).not.toContain("prob_draft");
  });
});
