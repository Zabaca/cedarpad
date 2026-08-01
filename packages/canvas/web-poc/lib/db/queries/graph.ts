import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { problemLinks, problems, solutionLinks, solutions } from "../schema.js";

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

export interface ContextEdge {
  id: string;
  direction: "out" | "in";
  /** The problem at the other end of the edge. */
  problemId: string;
  title: string;
  kind: string;
  similarity: number | null;
  rationale: string | null;
}

export interface ContextSolution {
  id: string;
  body: string;
  status: string;
  origin: string;
}

export interface ProblemContext {
  problem: { id: string; workspaceId: string; title: string; body: string; status: string };
  edges: ContextEdge[];
  solutions: ContextSolution[];
}

export interface NeighborhoodNode {
  id: string;
  title: string;
  status: string;
  /** Shortest hop distance from the root (0 = the root itself). */
  depth: number;
}

export interface NeighborhoodEdge {
  id: string;
  fromProblemId: string;
  toProblemId: string;
  kind: string;
  similarity: number | null;
  rationale: string | null;
}

export interface Neighborhood {
  rootId: string;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * True when a problem with this id exists IN this workspace — the root guard for
 * traversals. A root outside the caller's workspace is indistinguishable from
 * one that does not exist.
 */
async function problemInWorkspace(
  db: Database,
  problemId: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: problems.id })
    .from(problems)
    .where(and(eq(problems.id, problemId), eq(problems.workspaceId, workspaceId)))
    .limit(1);
  return rows.length > 0;
}

/** All solutions attached to a set of problems (via the polymorphic join). */
function problemSolutionJoin(ids: string[]) {
  return and(eq(solutionLinks.targetKind, "problem"), inArray(solutionLinks.targetId, ids));
}

/* ------------------------------------------------------------------ *
 * getProblemContext — node + its edges + attached solutions
 * ------------------------------------------------------------------ */

/**
 * One problem with its links (both directions, carrying the stored kind and
 * rationale) and attached solutions. The rationale is returned verbatim so the
 * agent reads *why* two problems relate instead of re-inferring it.
 *
 * Confined to `workspaceId`: the problem itself, and the problem at the far end
 * of every edge, must be in it. Returns `null` when the problem does not exist
 * there — a problem in another workspace is indistinguishable from a missing one.
 */
export async function getProblemContext(
  db: Database,
  params: { problemId: string; workspaceId: string },
): Promise<ProblemContext | null> {
  const { problemId, workspaceId } = params;
  const rows = await db
    .select({
      id: problems.id,
      workspaceId: problems.workspaceId,
      title: problems.title,
      body: problems.body,
      status: problems.status,
    })
    .from(problems)
    .where(and(eq(problems.id, problemId), eq(problems.workspaceId, workspaceId)))
    .limit(1);
  const problem = rows[0];
  if (!problem) return null;

  const outRows = await db
    .select({
      id: problemLinks.id,
      problemId: problemLinks.toProblemId,
      title: problems.title,
      kind: problemLinks.kind,
      similarity: problemLinks.similarity,
      rationale: problemLinks.rationale,
    })
    .from(problemLinks)
    .innerJoin(problems, eq(problems.id, problemLinks.toProblemId))
    .where(and(eq(problemLinks.fromProblemId, problemId), eq(problems.workspaceId, workspaceId)));

  const inRows = await db
    .select({
      id: problemLinks.id,
      problemId: problemLinks.fromProblemId,
      title: problems.title,
      kind: problemLinks.kind,
      similarity: problemLinks.similarity,
      rationale: problemLinks.rationale,
    })
    .from(problemLinks)
    .innerJoin(problems, eq(problems.id, problemLinks.fromProblemId))
    .where(and(eq(problemLinks.toProblemId, problemId), eq(problems.workspaceId, workspaceId)));

  const edges: ContextEdge[] = [
    ...outRows.map((r) => ({ ...r, direction: "out" as const })),
    ...inRows.map((r) => ({ ...r, direction: "in" as const })),
  ];

  const solRows = await db
    .select({
      id: solutions.id,
      body: solutions.body,
      status: solutions.status,
      origin: solutions.origin,
    })
    .from(solutionLinks)
    .innerJoin(solutions, eq(solutions.id, solutionLinks.solutionId))
    .where(problemSolutionJoin([problemId]));

  return { problem, edges, solutions: solRows };
}

/* ------------------------------------------------------------------ *
 * neighborhood — bounded multi-hop subgraph via a recursive CTE
 * ------------------------------------------------------------------ */

/**
 * Bounded subgraph around `rootId`. Walks `problem_links` undirected up to
 * `hops` levels (recursive CTE), caps the node set at `maxNodes`, then returns
 * the in-scope nodes (with shortest depth) and every edge between them.
 *
 * Both `hops` and `maxNodes` are hard ceilings so latency/context stay bounded.
 * The whole walk is confined to `workspaceId` — it never steps through a link
 * leaving it, so it can neither surface another workspace's problem nor route
 * through one. Returns `null` when the root problem is not in that workspace.
 */
export async function neighborhood(
  db: Database,
  params: {
    rootId: string;
    workspaceId: string;
    hops: number;
    maxNodes: number;
  },
): Promise<Neighborhood | null> {
  const { rootId, workspaceId, hops, maxNodes } = params;

  if (!(await problemInWorkspace(db, rootId, workspaceId))) return null;

  // Walk links in both directions up to `hops`; UNION dedupes (id, depth) rows
  // so the recursion terminates. GROUP BY id keeps the shortest depth per node.
  // The join onto `problems` is what confines the walk to one workspace: a link
  // pointing out of it is never stepped through, so the traversal cannot leak
  // another tenant's problem in — nor route around one to reach a third.
  const reached = await db.all<{ id: string; depth: number }>(sql`
    WITH RECURSIVE nbh(id, depth) AS (
      SELECT ${rootId}, 0
      UNION
      SELECT next.id, nbh.depth + 1
      FROM nbh
      JOIN problem_links pl
        ON pl.from_problem_id = nbh.id OR pl.to_problem_id = nbh.id
      JOIN problems next
        ON next.id = CASE WHEN pl.from_problem_id = nbh.id THEN pl.to_problem_id ELSE pl.from_problem_id END
       AND next.workspace_id = ${workspaceId}
      WHERE nbh.depth < ${hops}
    )
    SELECT id, MIN(depth) AS depth FROM nbh GROUP BY id LIMIT ${maxNodes}
  `);

  const depthById = new Map(reached.map((r) => [r.id, Number(r.depth)]));
  const reachedIds = [...depthById.keys()];

  const nodeRows = await db
    .select({ id: problems.id, title: problems.title, status: problems.status })
    .from(problems)
    .where(and(inArray(problems.id, reachedIds), eq(problems.workspaceId, workspaceId)));

  const nodes: NeighborhoodNode[] = nodeRows.map((n) => ({
    id: n.id,
    title: n.title,
    status: n.status,
    depth: depthById.get(n.id) ?? 0,
  }));
  const nodeIds = nodes.map((n) => n.id);

  const edgeRows =
    nodeIds.length > 0
      ? await db
          .select({
            id: problemLinks.id,
            fromProblemId: problemLinks.fromProblemId,
            toProblemId: problemLinks.toProblemId,
            kind: problemLinks.kind,
            similarity: problemLinks.similarity,
            rationale: problemLinks.rationale,
          })
          .from(problemLinks)
          .where(
            and(
              inArray(problemLinks.fromProblemId, nodeIds),
              inArray(problemLinks.toProblemId, nodeIds),
            ),
          )
      : [];

  return { rootId, nodes, edges: edgeRows };
}
