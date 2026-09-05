import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import type { Bindings } from "./context.js";
import { buildApp } from "./index.js";

/**
 * The `solved` list filter (`?solved=true`) keeps only observations/problems that
 * carry at least one **accepted** solution — the seam extracted as
 * `hasAcceptedSolution`. This pins that behaviour for all three list routes so the
 * shared helper cannot silently drift: a draft/rejected solution must NOT count,
 * and a target with no solution must NOT surface.
 */

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: "any",
} as unknown as Bindings;

const WS = "wsSolved";

let testDb: TestD1;
let db: Database;
let app: ReturnType<typeof buildApp>;

function call(path: string, init: RequestInit = {}) {
  return app.request(
    path,
    { ...init, headers: { "content-type": "application/json", "x-dev-workspace": WS, ...(init.headers ?? {}) } },
    env as unknown as Record<string, string>,
  );
}

const ids = async (res: Response) => ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });

  // obs_solved / prob_solved: an accepted solution. obs_draft / prob_draft: a
  // solution stuck at draft (must not count). obs_none / prob_none: no solution.
  await db.insert(schema.observations).values([
    { id: "obs_solved", workspaceId: WS, title: "solved obs", body: "x" },
    { id: "obs_draft", workspaceId: WS, title: "draft obs", body: "x" },
    { id: "obs_none", workspaceId: WS, title: "bare obs", body: "x" },
  ]);
  await db.insert(schema.problems).values([
    { id: "prob_solved", workspaceId: WS, title: "solved prob", body: "x" },
    { id: "prob_draft", workspaceId: WS, title: "draft prob", body: "x" },
    { id: "prob_none", workspaceId: WS, title: "bare prob", body: "x" },
  ]);
  await db.insert(schema.solutions).values([
    { id: "sol_acc_obs", body: "fix", origin: "human", status: "accepted" },
    { id: "sol_draft_obs", body: "maybe", origin: "human", status: "draft" },
    { id: "sol_acc_prob", body: "fix", origin: "human", status: "accepted" },
    { id: "sol_draft_prob", body: "maybe", origin: "human", status: "draft" },
  ]);
  await db.insert(schema.solutionLinks).values([
    { solutionId: "sol_acc_obs", targetKind: "observation", targetId: "obs_solved" },
    { solutionId: "sol_draft_obs", targetKind: "observation", targetId: "obs_draft" },
    { solutionId: "sol_acc_prob", targetKind: "problem", targetId: "prob_solved" },
    { solutionId: "sol_draft_prob", targetKind: "problem", targetId: "prob_draft" },
  ]);
});

afterAll(() => testDb.dispose());

describe("the solved filter keeps only targets with an accepted solution", () => {
  it("filters observations: only the one with an accepted solution", async () => {
    expect((await ids(await call("/v1/observations?solved=true"))).sort()).toEqual(["obs_solved"]);
  });

  it("filters problems: only the one with an accepted solution", async () => {
    expect((await ids(await call("/v1/problems?solved=true"))).sort()).toEqual(["prob_solved"]);
  });

  it("filters the unified items feed across both kinds", async () => {
    expect((await ids(await call("/v1/items?solved=true"))).sort()).toEqual(["obs_solved", "prob_solved"]);
  });

  it("without the filter, draft- and no-solution targets are still listed", async () => {
    const obs = await ids(await call("/v1/observations"));
    expect(obs).toContain("obs_draft");
    expect(obs).toContain("obs_none");
    const probs = await ids(await call("/v1/problems"));
    expect(probs).toContain("prob_draft");
    expect(probs).toContain("prob_none");
  });
});
