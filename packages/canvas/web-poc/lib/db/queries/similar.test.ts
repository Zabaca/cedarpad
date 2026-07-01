import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { findSimilarProblems } from "./similar.js";

/**
 * Integration test for the native libSQL vector path. Builds an in-memory DB
 * from the real migration, inserts problems with known embeddings, and asserts
 * vector_top_k orders by cosine similarity.
 *
 * Embeddings here are 1536-d (matching the schema) but sparse: each problem
 * activates a small set of dimensions, so "closeness" is easy to reason about.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Every migration's statements, in order — mirrors what the real migrator applies. */
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean),
    );
}

function basis(indices: number[], dims = 1536): number[] {
  const v = new Array(dims).fill(0);
  for (const i of indices) v[i] = 1;
  return v;
}

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

beforeAll(async () => {
  for (const stmt of migrationStatements()) {
    await client.execute(stmt);
  }

  await db.insert(schema.workspace).values([
    { id: "ws1", name: "WS", slug: "ws" },
    { id: "ws2", name: "WS2", slug: "ws2" },
  ]);

  // A and B share dims; C is orthogonal. D lives in a different workspace and
  // sits in its own cluster — used to prove similarity spans workspaces.
  await db.insert(schema.problems).values([
    { id: "A", workspaceId: "ws1", title: "A", body: "a", embedding: basis([0, 1, 2]) },
    { id: "B", workspaceId: "ws1", title: "B", body: "b", embedding: basis([0, 1, 3]) },
    { id: "C", workspaceId: "ws1", title: "C", body: "c", embedding: basis([500, 501]) },
    { id: "D", workspaceId: "ws2", title: "D", body: "d", embedding: basis([700, 701, 702]) },
  ]);
});

afterAll(() => client.close());

describe("findSimilarProblems", () => {
  it("orders results by cosine similarity and excludes self", async () => {
    const results = await findSimilarProblems(db, {
      queryVector: basis([0, 1, 2]), // identical to A
      topK: 5,
      excludeProblemId: "A",
    });

    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("A"); // self excluded
    expect(ids[0]).toBe("B"); // shares 2/3 dims with the query
    // B (similarity ~0.667) ranks above C (orthogonal, similarity 0)
    const b = results.find((r) => r.id === "B")!;
    const c = results.find((r) => r.id === "C");
    expect(b.similarity).toBeGreaterThan(c?.similarity ?? -1);
  });

  it("matches across workspaces (the graph is cross-tenant)", async () => {
    const results = await findSimilarProblems(db, {
      queryVector: basis([700, 701, 702]), // matches D, which lives in ws2
      topK: 5,
    });
    expect(results.map((r) => r.id)).toContain("D");
  });

  it("excludes archived rows from the scan", async () => {
    await db.insert(schema.problems).values({
      id: "E",
      workspaceId: "ws1",
      title: "E",
      body: "e",
      embedding: basis([0, 1, 2]), // identical to the query
      status: "archived",
    });
    const results = await findSimilarProblems(db, {
      queryVector: basis([0, 1, 2]),
      topK: 5,
    });
    // E is the closest possible match but archived → never a candidate.
    expect(results.map((r) => r.id)).not.toContain("E");
  });

  it("honours the recency window via `since`", async () => {
    // All seeded rows use the default createdAt (now); a future cutoff excludes them.
    const future = new Date(Date.now() + 60_000);
    const results = await findSimilarProblems(db, {
      queryVector: basis([0, 1, 2]),
      topK: 5,
      since: future,
    });
    expect(results).toHaveLength(0);
  });
});
