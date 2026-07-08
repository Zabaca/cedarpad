import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  observationSolvedMatchDismissals,
  observations,
  problemLinks,
  problems,
  solutionLinks,
  solutions,
} from "../schema.js";
import { findSimilarProblems } from "./similar.js";

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

export interface GraphSearchResult {
  id: string;
  title: string;
  body: string;
  similarity: number;
  status: string;
  /** Distinct kinds of links touching this problem (identical/partial/related). */
  linkKinds: string[];
  /** True when the problem has at least one accepted solution. */
  hasAcceptedSolution: boolean;
}

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

export interface SolvedMatch {
  problemId: string;
  title: string;
  body: string;
  similarity: number;
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
 * searchGraph — semantic search enriched with link/solution signals
 * ------------------------------------------------------------------ */

/**
 * Top-k semantically similar problems, each annotated with the kinds of links
 * already attached and whether it has an accepted solution. Backed by the exact
 * cosine scan in {@link findSimilarProblems} + a single-hop link join.
 *
 * Pass `workspaceId` to confine results to one platform workspace (Notebook
 * search isolation, #57): workspace A's search never returns workspace B's rows.
 */
export async function searchGraph(
  db: Database,
  params: {
    queryVector: number[];
    topK: number;
    excludeProblemId?: string;
    workspaceId?: string;
  },
): Promise<GraphSearchResult[]> {
  const hits = await findSimilarProblems(db, params);
  if (hits.length === 0) return [];

  const ids = hits.map((h) => h.id);

  const statusRows = await db
    .select({ id: problems.id, status: problems.status })
    .from(problems)
    .where(inArray(problems.id, ids));
  const statusById = new Map(statusRows.map((r) => [r.id, r.status]));

  const linkRows = await db
    .select({
      fromProblemId: problemLinks.fromProblemId,
      toProblemId: problemLinks.toProblemId,
      kind: problemLinks.kind,
    })
    .from(problemLinks)
    .where(
      or(inArray(problemLinks.fromProblemId, ids), inArray(problemLinks.toProblemId, ids)),
    );
  const kindsById = new Map<string, Set<string>>();
  const addKind = (id: string, kind: string) => {
    if (!ids.includes(id)) return;
    const set = kindsById.get(id) ?? new Set<string>();
    set.add(kind);
    kindsById.set(id, set);
  };
  for (const l of linkRows) {
    addKind(l.fromProblemId, l.kind);
    addKind(l.toProblemId, l.kind);
  }

  const solvedRows = await db
    .select({ problemId: solutionLinks.targetId })
    .from(solutionLinks)
    .innerJoin(solutions, eq(solutions.id, solutionLinks.solutionId))
    .where(and(problemSolutionJoin(ids), eq(solutions.status, "accepted")));
  const solved = new Set(solvedRows.map((r) => r.problemId));

  return hits.map((h) => ({
    id: h.id,
    title: h.title,
    body: h.body,
    similarity: h.similarity,
    status: statusById.get(h.id) ?? "open",
    linkKinds: [...(kindsById.get(h.id) ?? [])],
    hasAcceptedSolution: solved.has(h.id),
  }));
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

/* ------------------------------------------------------------------ *
 * Cross-kind: solved problems that look like an observation
 * ------------------------------------------------------------------ */

/**
 * Read-time cross-kind lookup powering the "this may already be solved" hint on
 * an observation. Uses the observation's *stored* embedding (no re-embed) to find
 * similar PROBLEMS that already carry an accepted solution, dropping any pair the
 * user has dismissed as a false positive. Cross-workspace, like every graph read.
 *
 * Returns `null` when the observation does not exist; `[]` when it has no
 * embedding yet (still queued) or nothing clears `minSimilarity`. Ordered by
 * similarity, highest first.
 */
export async function findSolvedProblemsForObservation(
  db: Database,
  params: { observationId: string; topK: number; minSimilarity: number },
): Promise<SolvedMatch[] | null> {
  const { observationId, topK, minSimilarity } = params;

  const obsRows = await db
    .select({ embedding: observations.embedding })
    .from(observations)
    .where(eq(observations.id, observationId))
    .limit(1);
  const obs = obsRows[0];
  if (!obs) return null;
  const embedding = obs.embedding;
  if (!embedding) return [];

  const hits = (await findSimilarProblems(db, { queryVector: embedding, topK })).filter(
    (h) => h.similarity >= minSimilarity,
  );
  if (hits.length === 0) return [];

  const ids = hits.map((h) => h.id);

  // One accepted solution per matched problem (first wins) — the hint only needs
  // to assert "this is solved over there", not enumerate every solution.
  const solRows = await db
    .select({
      problemId: solutionLinks.targetId,
      id: solutions.id,
      body: solutions.body,
      status: solutions.status,
      origin: solutions.origin,
    })
    .from(solutionLinks)
    .innerJoin(solutions, eq(solutions.id, solutionLinks.solutionId))
    .where(and(problemSolutionJoin(ids), eq(solutions.status, "accepted")));
  const solByProblem = new Map<string, ContextSolution>();
  for (const r of solRows) {
    if (!solByProblem.has(r.problemId)) {
      solByProblem.set(r.problemId, { id: r.id, body: r.body, status: r.status, origin: r.origin });
    }
  }

  // Pairs the user has already rejected as false positives.
  const dismissedRows = await db
    .select({ problemId: observationSolvedMatchDismissals.problemId })
    .from(observationSolvedMatchDismissals)
    .where(eq(observationSolvedMatchDismissals.observationId, observationId));
  const dismissed = new Set(dismissedRows.map((r) => r.problemId));

  return hits
    .filter((h) => solByProblem.has(h.id) && !dismissed.has(h.id))
    .map((h) => ({
      problemId: h.id,
      title: h.title,
      body: h.body,
      similarity: h.similarity,
      solution: solByProblem.get(h.id)!,
    }));
}

/**
 * Record a false-positive dismissal so the (observation, problem) match stops
 * being surfaced. Idempotent — re-dismissing the same pair is a no-op. Returns
 * `false` (no insert) when the problem does not exist, so the caller can 404
 * instead of letting the foreign key throw.
 */
export async function dismissSolvedMatch(
  db: Database,
  params: { observationId: string; problemId: string; createdBy: string | null },
): Promise<boolean> {
  // FK guard: a stale/invalid problemId would otherwise throw on insert.
  if (!(await problemExists(db, params.problemId))) return false;

  await db
    .insert(observationSolvedMatchDismissals)
    .values({
      observationId: params.observationId,
      problemId: params.problemId,
      createdBy: params.createdBy,
    })
    .onConflictDoNothing();
  return true;
}
