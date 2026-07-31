import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "./test-d1.js";

/**
 * The seam's honesty guard. The Notebook's similarity read and write paths were dead in
 * production for a month while 180 tests stayed green, because the test seam ran on
 * in-memory libSQL and production runs on D1 — `vector32()` and `vector_distance_cos()`
 * are libSQL functions D1 does not have. If this test ever passes such a statement, the
 * seam has drifted back off the production engine.
 */
describe("the test database is a real D1", () => {
  let d1: TestD1;
  beforeAll(async () => {
    d1 = await createTestD1();
  });
  afterAll(() => d1.dispose());

  it("rejects libSQL-only vector functions", async () => {
    await expect(d1.d1.prepare("SELECT vector32('[1,2,3]')").run()).rejects.toThrow();
    await expect(
      d1.d1.prepare("SELECT vector_distance_cos(vector32('[1,2]'), vector32('[1,2]'))").run(),
    ).rejects.toThrow();
  });

  it("applied the real migrations", async () => {
    const { results } = await d1.d1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='problems'")
      .all();
    expect(results).toHaveLength(1);
  });
});
