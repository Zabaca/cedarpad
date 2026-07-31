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

  /*
   * Foreign-key *actions* are the one kind of schema drift drizzle-kit cannot see:
   * it diffs schema.ts against the snapshot, never against a database. `ALTER TABLE
   * ADD COLUMN` drops the `ON DELETE` clause, so `source_id` arrived as NO ACTION
   * while schema.ts and the snapshot both said `set null` — agreeing with each other
   * and with nothing else. Assert the behaviour the schema promises, against the
   * migrated engine, or the next one goes unnoticed too.
   */
  it("nulls an Observation's Source pointer when the Source is deleted", async () => {
    await d1.d1
      .prepare("INSERT INTO sources (id, workspace_id, kind) VALUES ('src_fk', 'ws_fk', 'url')")
      .run();
    await d1.d1
      .prepare(
        "INSERT INTO observations (id, workspace_id, title, body, source_id) VALUES ('obs_fk', 'ws_fk', 't', 'b', 'src_fk')",
      )
      .run();

    await d1.d1.prepare("DELETE FROM sources WHERE id = 'src_fk'").run();

    const { results } = await d1.d1
      .prepare("SELECT source_id FROM observations WHERE id = 'obs_fk'")
      .all();
    expect(results).toEqual([{ source_id: null }]);
  });
});
