import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

/*
 * The `solved=true` list filter (worker/index.ts `solvedFilter`): "rows that carry at
 * least one accepted solution". One definition serves both the observation and problem
 * lists, so both branches are asserted here through the same seam the package tests at —
 * `buildApp({ db })` over a real D1, every fact established over HTTP.
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

async function req(path: string, init: RequestInit = {}) {
  return app.request(
    path,
    { ...init, headers: { "content-type": "application/json", "x-dev-workspace": WORKSPACE, ...(init.headers ?? {}) } },
    env,
  );
}

const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });

/** Attach an accepted solution to a target (POST /v1/solutions stores it as `accepted`). */
const accept = (targetKind: "observation" | "problem", targetId: string) =>
  post("/v1/solutions", { targetKind, targetId, body: "The fix that stuck." });

const listIds = async (path: string): Promise<string[]> => {
  const res = await req(path);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
};

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });
  await db.insert(schema.workspace).values({ id: WORKSPACE, name: "Solved WS", slug: "solved-ws" });
});

afterAll(() => testDb.dispose());

describe("the solved=true list filter", () => {
  it("keeps only observations with an accepted solution", async () => {
    const solved = ((await (await post("/v1/observations", { title: "solved obs", body: "b" })).json()) as { observation: { id: string } }).observation.id;
    const open = ((await (await post("/v1/observations", { title: "open obs", body: "b" })).json()) as { observation: { id: string } }).observation.id;
    await accept("observation", solved);

    expect(await listIds("/v1/observations")).toEqual(expect.arrayContaining([solved, open]));
    const filtered = await listIds("/v1/observations?solved=true");
    expect(filtered).toContain(solved);
    expect(filtered).not.toContain(open);
  });

  it("keeps only problems with an accepted solution", async () => {
    const solved = ((await (await post("/v1/problems", { title: "solved prob", body: "b" })).json()) as { problem: { id: string } }).problem.id;
    const open = ((await (await post("/v1/problems", { title: "open prob", body: "b" })).json()) as { problem: { id: string } }).problem.id;
    await accept("problem", solved);

    expect(await listIds("/v1/problems")).toEqual(expect.arrayContaining([solved, open]));
    const filtered = await listIds("/v1/problems?solved=true");
    expect(filtered).toContain(solved);
    expect(filtered).not.toContain(open);
  });
});
