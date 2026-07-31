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

export interface SolvedNeighbor {
  problemId: string;
  title: string;
  depth: number;
  solution: ContextSolution;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** True when a problem with this id exists — the root guard for traversals. */
async function problemExists(db: Database, problemId: string): Promise<boolean> {
  const rows = await db
    .select({ id: problems.id })
    .from(problems)
    .where(eq(problems.id, problemId))
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
 * One problem with its links (both directions, carrying the stored
 * kind/similarity/rationale) and attached solutions. The rationale is returned
 * verbatim so the agent reads *why* two problems relate instead of re-inferring.
 * Returns `null` when the problem does not exist.
 */
export async function getProblemContext(
  db: Database,
  problemId: string,
): Promise<ProblemContext | null> {
  const rows = await db
    .select({
      id: problems.id,
      workspaceId: problems.workspaceId,
      title: problems.title,
      body: problems.body,
      status: problems.status,
    })
    .from(problems)
    .where(eq(problems.id, problemId))
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
    .where(eq(problemLinks.fromProblemId, problemId));

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
    .where(eq(problemLinks.toProblemId, problemId));

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
 * Returns `null` when the root problem does not exist.
 */
export async function neighborhood(
  db: Database,
  params: {
    rootId: string;
    hops: number;
    maxNodes: number;
  },
): Promise<Neighborhood | null> {
  const { rootId, hops, maxNodes } = params;

  if (!(await problemExists(db, rootId))) return null;

  // Walk links in both directions up to `hops`; UNION dedupes (id, depth) rows
  // so the recursion terminates. GROUP BY id keeps the shortest depth per node.
  const reached = await db.all<{ id: string; depth: number }>(sql`
    WITH RECURSIVE nbh(id, depth) AS (
      SELECT ${rootId}, 0
      UNION
      SELECT
        CASE WHEN pl.from_problem_id = nbh.id THEN pl.to_problem_id ELSE pl.from_problem_id END,
        nbh.depth + 1
      FROM nbh
      JOIN problem_links pl
        ON pl.from_problem_id = nbh.id OR pl.to_problem_id = nbh.id
      WHERE nbh.depth < ${hops}
    )
    SELECT id, MIN(depth) AS depth FROM nbh GROUP BY id LIMIT ${maxNodes}
  `);

  const depthById = new Map(reached.map((r) => [r.id, Number(r.depth)]));
  const reachedIds = [...depthById.keys()];

  // The graph spans every workspace, so materialisation is unfiltered by tenant.
  const nodeRows = await db
    .select({ id: problems.id, title: problems.title, status: problems.status })
    .from(problems)
    .where(inArray(problems.id, reachedIds));

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

/* ------------------------------------------------------------------ *
 * findSolvedNeighbors — nearest neighbours that already have solutions
 * ------------------------------------------------------------------ */

/**
 * Problems within `hops` of `rootId` that already carry an accepted solution,
 * nearest first. Lets the agent jump straight to reusable prior work. Returns
 * `null` when the root problem does not exist.
 */
export async function findSolvedNeighbors(
  db: Database,
  params: {
    rootId: string;
    hops: number;
    maxNodes: number;
  },
): Promise<SolvedNeighbor[] | null> {
  const { rootId, hops, maxNodes } = params;

  if (!(await problemExists(db, rootId))) return null;

  const reached = await db.all<{ id: string; depth: number }>(sql`
    WITH RECURSIVE nbh(id, depth) AS (
      SELECT ${rootId}, 0
      UNION
      SELECT
        CASE WHEN pl.from_problem_id = nbh.id THEN pl.to_problem_id ELSE pl.from_problem_id END,
        nbh.depth + 1
      FROM nbh
      JOIN problem_links pl
        ON pl.from_problem_id = nbh.id OR pl.to_problem_id = nbh.id
      WHERE nbh.depth < ${hops}
    )
    SELECT id, MIN(depth) AS depth FROM nbh GROUP BY id LIMIT ${maxNodes}
  `);

  const depthById = new Map(reached.map((r) => [r.id, Number(r.depth)]));
  // Exclude the root itself — we want *other* problems with solutions.
  const ids = [...depthById.keys()].filter((id) => id !== rootId);
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      problemId: problems.id,
      title: problems.title,
      id: solutions.id,
      body: solutions.body,
      status: solutions.status,
      origin: solutions.origin,
    })
    .from(problems)
    .innerJoin(
      solutionLinks,
      and(eq(solutionLinks.targetKind, "problem"), eq(solutionLinks.targetId, problems.id)),
    )
    .innerJoin(solutions, eq(solutions.id, solutionLinks.solutionId))
    .where(and(inArray(problems.id, ids), eq(solutions.status, "accepted")));

  return rows
    .map((r) => ({
      problemId: r.problemId,
      title: r.title,
      depth: depthById.get(r.problemId) ?? 1,
      solution: { id: r.id, body: r.body, status: r.status, origin: r.origin },
    }))
    .sort((a, b) => a.depth - b.depth);
}
