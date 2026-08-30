import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import type { Bindings } from "./context.js";
import { buildApp } from "./index.js";

/**
 * The `solved` list filter — "carries at least one accepted solution" — is the
 * one predicate the observations, problems, and items routes all share
 * (`hasAcceptedSolution` in data.ts). A POST /v1/solutions creates an already
 * "accepted" solution, so attaching one flips its target to solved. One target
 * of each kind gets a solution; its unsolved sibling does not.
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
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-dev-workspace": WS,
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
    { id: "prob_solved", workspaceId: WS, title: "solved problem", body: "has a fix" },
    { id: "prob_unsolved", workspaceId: WS, title: "unsolved problem", body: "no fix yet" },
  ]);
  await db.insert(schema.observations).values([
    { id: "obs_solved", workspaceId: WS, title: "solved obs", body: "has a fix" },
    { id: "obs_unsolved", workspaceId: WS, title: "unsolved obs", body: "no fix yet" },
  ]);

  // A created solution is already `accepted`, so these two targets are now solved.
  expect(
    (await call("/v1/solutions", json({ targetKind: "problem", targetId: "prob_solved", body: "fix", origin: "human" }))).status,
  ).toBe(201);
  expect(
    (await call("/v1/solutions", json({ targetKind: "observation", targetId: "obs_solved", body: "fix", origin: "human" }))).status,
  ).toBe(201);
});

afterAll(() => testDb.dispose());

describe("the `solved` filter keeps only targets with an accepted solution", () => {
  it("filters the problems list", async () => {
    const all = (await (await call("/v1/problems")).json()) as { items: { id: string }[] };
    expect(all.items.map((p) => p.id).sort()).toEqual(["prob_solved", "prob_unsolved"]);

    const solved = (await (await call("/v1/problems?solved=true")).json()) as { items: { id: string }[] };
    expect(solved.items.map((p) => p.id)).toEqual(["prob_solved"]);
  });

  it("filters the observations list", async () => {
    const all = (await (await call("/v1/observations")).json()) as { items: { id: string }[] };
    expect(all.items.map((o) => o.id).sort()).toEqual(["obs_solved", "obs_unsolved"]);

    const solved = (await (await call("/v1/observations?solved=true")).json()) as { items: { id: string }[] };
    expect(solved.items.map((o) => o.id)).toEqual(["obs_solved"]);
  });

  it("filters the unified item feed across both kinds", async () => {
    const solved = (await (await call("/v1/items?solved=true")).json()) as { items: { id: string }[] };
    expect(solved.items.map((i) => i.id).sort()).toEqual(["obs_solved", "prob_solved"]);
  });
});
