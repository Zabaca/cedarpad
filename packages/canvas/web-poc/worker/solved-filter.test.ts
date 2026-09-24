import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

/*
 * The `?solved=true` list filter — observations, problems, and the unified feed —
 * all reduce to one shared `EXISTS` fragment (`hasAcceptedSolution` in
 * `worker/index.ts`). This pins that fragment through the ONE seam the package
 * tests at (`buildApp({ db })` over a real D1): a row counts as "solved" only when
 * it carries an *accepted* solution link — a draft solution does not qualify.
 */

const WORKSPACE = "ws_solved";

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: WORKSPACE,
} as Record<string, string>;

let testDb: TestD1;
let db: Database;
let app: ReturnType<typeof buildApp>;

async function req(path: string) {
  return app.request(
    path,
    { headers: { "content-type": "application/json", "x-dev-workspace": WORKSPACE } },
    env,
  );
}

async function ids(path: string): Promise<string[]> {
  const res = await req(path);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string }[] };
  return body.items.map((i) => i.id);
}

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });

  await db.insert(schema.workspace).values({
    id: WORKSPACE,
    name: "Solved Filter Workspace",
    slug: "solved-filter-workspace",
  });

  await db.insert(schema.observations).values([
    { id: "obs_solved", workspaceId: WORKSPACE, title: "Solved observation", body: "b" },
    { id: "obs_draft", workspaceId: WORKSPACE, title: "Draft-only observation", body: "b" },
    { id: "obs_unsolved", workspaceId: WORKSPACE, title: "Unsolved observation", body: "b" },
  ]);
  await db.insert(schema.problems).values([
    { id: "prob_solved", workspaceId: WORKSPACE, title: "Solved problem", body: "b" },
    { id: "prob_unsolved", workspaceId: WORKSPACE, title: "Unsolved problem", body: "b" },
  ]);

  await db.insert(schema.solutions).values([
    { id: "sol_accepted", body: "accepted fix", origin: "human", status: "accepted" },
    { id: "sol_draft", body: "draft fix", origin: "human", status: "draft" },
    { id: "sol_prob", body: "accepted problem fix", origin: "human", status: "accepted" },
  ]);
  await db.insert(schema.solutionLinks).values([
    { solutionId: "sol_accepted", targetKind: "observation", targetId: "obs_solved" },
    { solutionId: "sol_draft", targetKind: "observation", targetId: "obs_draft" },
    { solutionId: "sol_prob", targetKind: "problem", targetId: "prob_solved" },
  ]);
});

afterAll(() => testDb.dispose());

describe("GET /v1/observations?solved", () => {
  it("returns only observations with an accepted solution", async () => {
    const solved = await ids("/v1/observations?solved=true");
    expect(solved).toContain("obs_solved");
    expect(solved).not.toContain("obs_unsolved");
    // A draft solution does not make an observation solved.
    expect(solved).not.toContain("obs_draft");
  });

  it("returns all observations when the filter is absent", async () => {
    const all = await ids("/v1/observations");
    expect(all).toEqual(expect.arrayContaining(["obs_solved", "obs_draft", "obs_unsolved"]));
  });
});

describe("GET /v1/problems?solved", () => {
  it("returns only problems with an accepted solution", async () => {
    const solved = await ids("/v1/problems?solved=true");
    expect(solved).toContain("prob_solved");
    expect(solved).not.toContain("prob_unsolved");
  });
});

describe("GET /v1/items?solved (unified feed)", () => {
  it("returns only observations and problems with an accepted solution", async () => {
    const solved = await ids("/v1/items?solved=true");
    expect(solved).toEqual(expect.arrayContaining(["obs_solved", "prob_solved"]));
    expect(solved).not.toContain("obs_unsolved");
    expect(solved).not.toContain("obs_draft");
    expect(solved).not.toContain("prob_unsolved");
  });
});
