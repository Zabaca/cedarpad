import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../client.js";
import { clusterSummaries, solutionLinks, solutions } from "../schema.js";
import { neighborhood } from "./graph.js";

export interface ClusterMember {
  problemId: string;
  title: string;
  /** Hop distance from the cluster root (0 = the root problem). */
  depth: number;
  solutions: { body: string; status: string; origin: string }[];
}

export interface ClusterMembership {
  rootProblemId: string;
  rootTitle: string;
  members: ClusterMember[];
  /** Stable hash of the sorted member ids — the cache key for a summary. */
  membershipHash: string;
}

/** FNV-1a over a string → 8-char hex. Deterministic, dependency-free. */
function fnv1aHex(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Hash of the cluster's membership: sorted, deduped member ids. */
export function membershipHash(memberIds: string[]): string {
  const sorted = [...new Set(memberIds)].sort();
  return fnv1aHex(sorted.join(","));
}

/**
 * Resolve the cluster around `rootId` (bounded neighborhood) into its member
 * problems with attached solutions, plus a membership hash. No LLM — pure
 * stored-row retrieval. Returns `null` when the root problem does not exist.
 * `maxMembers` caps how many members (root first, then nearest) are folded in.
 */
export async function getClusterMembership(
  db: Database,
  params: { rootId: string; hops: number; maxNodes: number; maxMembers: number },
): Promise<ClusterMembership | null> {
  const { rootId, hops, maxNodes, maxMembers } = params;
  const nbh = await neighborhood(db, { rootId, hops, maxNodes });
  if (!nbh) return null;

  // Root first, then nearest by depth; cap the member set.
  const ordered = [...nbh.nodes].sort((a, b) => a.depth - b.depth).slice(0, maxMembers);
  const ids = ordered.map((n) => n.id);
  const rootTitle = nbh.nodes.find((n) => n.id === rootId)?.title ?? rootId;

  const solRows = ids.length
    ? await db
        .select({
          problemId: solutionLinks.targetId,
          body: solutions.body,
          status: solutions.status,
          origin: solutions.origin,
        })
        .from(solutionLinks)
        .innerJoin(solutions, eq(solutions.id, solutionLinks.solutionId))
        .where(and(eq(solutionLinks.targetKind, "problem"), inArray(solutionLinks.targetId, ids)))
    : [];
  const byProblem = new Map<string, { body: string; status: string; origin: string }[]>();
  for (const r of solRows) {
    const arr = byProblem.get(r.problemId) ?? [];
    arr.push({ body: r.body, status: r.status, origin: r.origin });
    byProblem.set(r.problemId, arr);
  }

  const members: ClusterMember[] = ordered.map((n) => ({
    problemId: n.id,
    title: n.title,
    depth: n.depth,
    solutions: byProblem.get(n.id) ?? [],
  }));

  return { rootProblemId: rootId, rootTitle, members, membershipHash: membershipHash(ids) };
}

/** Most recent cached summary for a cluster root, or `null`. */
export async function readClusterSummary(db: Database, rootProblemId: string) {
  const rows = await db
    .select()
    .from(clusterSummaries)
    .where(eq(clusterSummaries.rootProblemId, rootProblemId))
    .orderBy(desc(clusterSummaries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Replace any cached summary for a root with a fresh one (one row per root). */
export async function writeClusterSummary(
  db: Database,
  input: {
    id: string;
    rootProblemId: string;
    membershipHash: string;
    summary: string;
    memberCount: number;
    model: string | null;
  },
): Promise<void> {
  await db.delete(clusterSummaries).where(eq(clusterSummaries.rootProblemId, input.rootProblemId));
  await db.insert(clusterSummaries).values({
    id: input.id,
    rootProblemId: input.rootProblemId,
    membershipHash: input.membershipHash,
    summary: input.summary,
    memberCount: input.memberCount,
    model: input.model,
  });
}
