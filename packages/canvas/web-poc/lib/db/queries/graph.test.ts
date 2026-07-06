import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import {
  dismissSolvedMatch,
  findSolvedNeighbors,
  findSolvedProblemsForObservation,
  getProblemContext,
  neighborhood,
  searchGraph,
} from "./graph.js";

/**
 * Integration test for the structural-graph retrieval queries. Builds an
 * in-memory DB from the real migration and a small fixed graph:
 *
 *   ws1: A —identical→ B —partial→ C        (C has an accepted solution)
 *        A —related→ D  (D lives in ws2 → cross-workspace edge)
 *   ws3: E  (isolated — no links, so traversal never reaches it)
 *
 * The graph layer is cross-workspace by design, so traversal and similarity
 * cross tenant boundaries; a node is excluded only when no edge reaches it.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

function basis(indices: number[], dims = 1536): number[] {
  const v = new Array(dims).fill(0);
  for (const i of indices) v[i] = 1;
  return v;
}

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

beforeAll(async () => {
  // Apply every migration in order so newer tables (e.g. dismissals) exist too.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sqlText = readFileSync(MIGRATIONS_DIR + f, "utf8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    for (const stmt of statements) await client.execute(stmt);
  }

  await db.insert(schema.workspace).values([
    { id: "ws1", name: "WS1", slug: "ws1" },
    { id: "ws2", name: "WS2", slug: "ws2" },
    { id: "ws3", name: "WS3", slug: "ws3" },
  ]);

  await db.insert(schema.problems).values([
    { id: "A", workspaceId: "ws1", title: "A", body: "a", embedding: basis([0, 1, 2]) },
    { id: "B", workspaceId: "ws1", title: "B", body: "b", embedding: basis([0, 1, 3]) },
    { id: "C", workspaceId: "ws1", title: "C", body: "c", embedding: basis([0, 4, 5]) },
    { id: "D", workspaceId: "ws2", title: "D", body: "d", embedding: basis([0, 1, 6]) },
    { id: "E", workspaceId: "ws3", title: "E", body: "e", embedding: basis([500, 501]) },
  ]);

  await db.insert(schema.problemLinks).values([
    { id: "lAB", fromProblemId: "A", toProblemId: "B", kind: "identical", similarity: 0.95 },
    { id: "lBC", fromProblemId: "B", toProblemId: "C", kind: "partial", similarity: 0.8 },
    { id: "lAD", fromProblemId: "A", toProblemId: "D", kind: "related", similarity: 0.7 },
  ]);

  // C has an accepted solution; B has only a draft.
  await db.insert(schema.solutions).values([
    { id: "solC", body: "fix for C", origin: "synthesized", status: "accepted" },
    { id: "solB", body: "draft for B", origin: "synthesized", status: "draft" },
  ]);
  await db.insert(schema.solutionLinks).values([
    { solutionId: "solC", targetKind: "problem", targetId: "C" },
    { solutionId: "solB", targetKind: "problem", targetId: "B" },
  ]);

  // Observations for the cross-kind solved-match hint:
  //   O1 embeds like C (solved) and B (draft only); O2 has no embedding yet.
  await db.insert(schema.observations).values([
    { id: "O1", workspaceId: "ws1", title: "O1", body: "o1", embedding: basis([0, 4, 5]) },
    { id: "O2", workspaceId: "ws1", title: "O2", body: "o2", embedding: null },
  ]);
});

afterAll(() => client.close());

describe("getProblemContext", () => {
  it("returns the node, its directed edges, and attached solutions", async () => {
    const ctx = (await getProblemContext(db, "B"))!;
    expect(ctx.problem.id).toBe("B");

    const out = ctx.edges.filter((e) => e.direction === "out");
    const inc = ctx.edges.filter((e) => e.direction === "in");
    expect(out.map((e) => e.problemId)).toEqual(["C"]); // B → C
    expect(inc.map((e) => e.problemId)).toEqual(["A"]); // A → B
    expect(out[0]!.kind).toBe("partial");
    expect(ctx.solutions.map((s) => s.id)).toEqual(["solB"]);
  });

  it("returns null for a missing problem", async () => {
    expect(await getProblemContext(db, "nope")).toBeNull();
  });
});

describe("neighborhood", () => {
  it("expands to the hop limit across workspaces", async () => {
    const nb = (await neighborhood(db, { rootId: "A", hops: 2, maxNodes: 50 }))!;
    const ids = nb.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["A", "B", "C", "D"]); // D (ws2) included — graph is cross-workspace
    expect(nb.nodes.find((n) => n.id === "A")!.depth).toBe(0);
    expect(nb.nodes.find((n) => n.id === "C")!.depth).toBe(2);
    expect(nb.nodes.find((n) => n.id === "D")!.depth).toBe(1);
    // Every edge among included nodes (A→B, B→C, A→D).
    expect(nb.edges.map((e) => e.id).sort()).toEqual(["lAB", "lAD", "lBC"]);
  });

  it("honours the hop ceiling", async () => {
    const nb = (await neighborhood(db, { rootId: "A", hops: 1, maxNodes: 50 }))!;
    // A's direct neighbours in any workspace: B (ws1) and D (ws2).
    expect(nb.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "D"]);
  });

  it("returns null for a missing root", async () => {
    expect(await neighborhood(db, { rootId: "nope", hops: 2, maxNodes: 50 })).toBeNull();
  });
});

describe("findSolvedNeighbors", () => {
  it("returns only neighbours with an accepted solution, nearest first", async () => {
    const solved = (await findSolvedNeighbors(db, { rootId: "A", hops: 2, maxNodes: 50 }))!;
    expect(solved.map((s) => s.problemId)).toEqual(["C"]); // B's draft excluded
    expect(solved[0]!.solution.id).toBe("solC");
    expect(solved[0]!.depth).toBe(2);
  });
});

describe("searchGraph", () => {
  it("annotates hits with link kinds and accepted-solution flags", async () => {
    const results = await searchGraph(db, {
      queryVector: basis([0, 1, 2]), // closest to A
      topK: 5,
      excludeProblemId: "A",
    });
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get("B")!.linkKinds.sort()).toEqual(["identical", "partial"]);
    expect(byId.get("C")!.hasAcceptedSolution).toBe(true);
    expect(byId.get("B")!.hasAcceptedSolution).toBe(false);
  });
});

describe("findSolvedProblemsForObservation", () => {
  it("returns only similar problems with an accepted solution", async () => {
    const matches = (await findSolvedProblemsForObservation(db, {
      observationId: "O1",
      topK: 5,
      minSimilarity: 0.5,
    }))!;
    // C is solved (accepted) and embeds like O1; B is only a draft → excluded.
    expect(matches.map((m) => m.problemId)).toEqual(["C"]);
    expect(matches[0]!.solution.id).toBe("solC");
  });

  it("returns [] when the observation has no embedding yet", async () => {
    expect(
      await findSolvedProblemsForObservation(db, { observationId: "O2", topK: 5, minSimilarity: 0.5 }),
    ).toEqual([]);
  });

  it("returns null for a missing observation", async () => {
    expect(
      await findSolvedProblemsForObservation(db, { observationId: "nope", topK: 5, minSimilarity: 0.5 }),
    ).toBeNull();
  });

  it("excludes a dismissed match (idempotently)", async () => {
    expect(await dismissSolvedMatch(db, { observationId: "O1", problemId: "C", createdBy: "u1" })).toBe(
      true,
    );
    // re-dismiss is a no-op but still succeeds
    expect(await dismissSolvedMatch(db, { observationId: "O1", problemId: "C", createdBy: "u1" })).toBe(
      true,
    );

    const matches = (await findSolvedProblemsForObservation(db, {
      observationId: "O1",
      topK: 5,
      minSimilarity: 0.5,
    }))!;
    expect(matches).toEqual([]);
  });

  it("refuses to dismiss against a non-existent problem (FK guard)", async () => {
    expect(
      await dismissSolvedMatch(db, { observationId: "O1", problemId: "nope", createdBy: "u1" }),
    ).toBe(false);
  });
});
