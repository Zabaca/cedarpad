import { eq } from "drizzle-orm";
import { applyMigrations, createTestDb } from "../test-support.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import {
  getClusterMembership,
  membershipHash,
  readClusterSummary,
  writeClusterSummary,
} from "./clusterSummary.js";

/**
 * Cluster-summary cache + membership. Fixture (one workspace):
 *   A —identical→ B —partial→ C   (C has an accepted solution, B a draft)
 */
const { client, db } = createTestDb();

beforeAll(async () => {
  await applyMigrations(client);

  await db.insert(schema.workspace).values([{ id: "ws1", name: "WS1", slug: "ws1" }]);
  await db.insert(schema.problems).values([
    { id: "A", workspaceId: "ws1", title: "A", body: "a" },
    { id: "B", workspaceId: "ws1", title: "B", body: "b" },
    { id: "C", workspaceId: "ws1", title: "C", body: "c" },
  ]);
  await db.insert(schema.problemLinks).values([
    { id: "lAB", fromProblemId: "A", toProblemId: "B", kind: "identical", similarity: 0.95 },
    { id: "lBC", fromProblemId: "B", toProblemId: "C", kind: "partial", similarity: 0.8 },
  ]);
  await db.insert(schema.solutions).values([
    { id: "solC", body: "fix for C", origin: "synthesized", status: "accepted" },
  ]);
  await db.insert(schema.solutionLinks).values([
    { solutionId: "solC", targetKind: "problem", targetId: "C" },
  ]);
});

afterAll(() => client.close());

describe("membershipHash", () => {
  it("is order-independent and dedupes", () => {
    expect(membershipHash(["A", "B", "C"])).toBe(membershipHash(["C", "A", "B", "A"]));
    expect(membershipHash(["A", "B"])).not.toBe(membershipHash(["A", "B", "C"]));
  });
});

describe("getClusterMembership", () => {
  it("returns root-first members with their solutions and a stable hash", async () => {
    const m = (await getClusterMembership(db, {
      rootId: "A",
      hops: 2,
      maxNodes: 100,
      maxMembers: 50,
    }))!;
    expect(m.rootProblemId).toBe("A");
    expect(m.members[0]!.problemId).toBe("A"); // root first (depth 0)
    expect(m.members.map((x) => x.problemId).sort()).toEqual(["A", "B", "C"]);
    const c = m.members.find((x) => x.problemId === "C")!;
    expect(c.solutions).toEqual([{ body: "fix for C", status: "accepted", origin: "synthesized" }]);
    expect(m.membershipHash).toBe(membershipHash(["A", "B", "C"]));
  });

  it("returns null for a missing root", async () => {
    expect(
      await getClusterMembership(db, { rootId: "nope", hops: 2, maxNodes: 100, maxMembers: 50 }),
    ).toBeNull();
  });
});

describe("cluster summary cache", () => {
  it("writes then reads back the latest summary, replacing prior rows", async () => {
    expect(await readClusterSummary(db, "A")).toBeNull();

    await writeClusterSummary(db, {
      id: "cs_1",
      rootProblemId: "A",
      membershipHash: "hash_v1",
      summary: "first summary",
      memberCount: 3,
      model: "heuristic",
    });
    expect((await readClusterSummary(db, "A"))!.summary).toBe("first summary");

    // A second write replaces the first (one row per root).
    await writeClusterSummary(db, {
      id: "cs_2",
      rootProblemId: "A",
      membershipHash: "hash_v2",
      summary: "second summary",
      memberCount: 4,
      model: "anthropic:claude",
    });
    const latest = (await readClusterSummary(db, "A"))!;
    expect(latest.summary).toBe("second summary");
    expect(latest.membershipHash).toBe("hash_v2");

    const all = await db
      .select()
      .from(schema.clusterSummaries)
      .where(eq(schema.clusterSummaries.rootProblemId, "A"));
    expect(all.length).toBe(1);
  });
});
