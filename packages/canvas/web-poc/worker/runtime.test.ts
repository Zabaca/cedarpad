import { describe, expect, it } from "vitest";
import type { Bindings } from "./context.js";
import { schema } from "../lib/db/index.js";
import { createDbForWorker } from "./runtime.js";

/** Minimal D1 stand-in: records the SQL Drizzle prepares and returns no rows. */
function fakeD1() {
  const prepared: string[] = [];
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
    first: async () => null,
  };
  return {
    prepared,
    binding: {
      prepare(sql: string) {
        prepared.push(sql);
        return stmt;
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    },
  };
}

describe("createDbForWorker", () => {
  it("queries the D1 binding", async () => {
    const d1 = fakeD1();
    const db = createDbForWorker({
      PLATFORM_DB: d1.binding,
    } as unknown as Bindings);

    await db.select().from(schema.workspaces);

    expect(d1.prepared.join("\n")).toContain("workspaces");
  });
});
