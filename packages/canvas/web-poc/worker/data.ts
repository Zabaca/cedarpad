import type { Database } from "../lib/db/index.js";
import { schema } from "../lib/db/index.js";
import type { Graph, ObservationDetail, ProblemDetail } from "../lib/contract/index.js";
import { aliasedTable, and, desc, eq, inArray } from "drizzle-orm";
import { type AccessScope, workspaceFilter } from "./access.js";
import {
  serializeObservation,
  serializeObservationLink,
  serializeProblem,
  serializeProblemLink,
  serializeRun,
  serializeSolution,
} from "./serializers.js";

type TargetKind = "observation" | "problem";

/** The workspace a problem belongs to, or null if it does not exist. */
export async function getProblemWorkspaceId(db: Database, id: string): Promise<string | null> {
  const rows = await db
    .select({ workspaceId: schema.problems.workspaceId })
    .from(schema.problems)
    .where(eq(schema.problems.id, id))
    .limit(1);
  return rows[0]?.workspaceId ?? null;
}

/** Solutions attached to a polymorphic target (observation or problem). */
async function solutionsForTarget(db: Database, kind: TargetKind, id: string) {
  const rows = await db
    .select({ solution: schema.solutions })
    .from(schema.solutionLinks)
    .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
    .where(and(eq(schema.solutionLinks.targetKind, kind), eq(schema.solutionLinks.targetId, id)));
  return rows.map((r) => serializeSolution(r.solution));
}

/** The latest agent run recorded against a target. */
async function latestRunForTarget(db: Database, kind: TargetKind, id: string) {
  const rows = await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.targetKind, kind), eq(schema.agentRuns.targetId, id)))
    .orderBy(desc(schema.agentRuns.createdAt))
    .limit(1);
  return rows[0] ? serializeRun(rows[0]) : null;
}

/** Remove all solution links for a target before the target is deleted (no DB cascade). */
export async function deleteSolutionLinksForTarget(
  db: Database,
  kind: TargetKind,
  id: string,
): Promise<void> {
  await db
    .delete(schema.solutionLinks)
    .where(and(eq(schema.solutionLinks.targetKind, kind), eq(schema.solutionLinks.targetId, id)));
}

export async function getProblemDetail(db: Database, id: string): Promise<ProblemDetail | null> {
  const problemRows = await db
    .select()
    .from(schema.problems)
    .where(eq(schema.problems.id, id))
    .limit(1);
  const problem = problemRows[0];
  if (!problem) return null;

  const linked = aliasedTable(schema.problems, "linked");
  const linkRows = await db
    .select({ link: schema.problemLinks, problem: linked })
    .from(schema.problemLinks)
    .innerJoin(linked, eq(linked.id, schema.problemLinks.toProblemId))
    .where(eq(schema.problemLinks.fromProblemId, id));

  const sourceRows = await db
    .select({
      id: schema.observations.id,
      title: schema.observations.title,
      rationale: schema.observationProblems.rationale,
      relevance: schema.observationProblems.relevance,
    })
    .from(schema.observationProblems)
    .innerJoin(
      schema.observations,
      eq(schema.observations.id, schema.observationProblems.observationId),
    )
    .where(eq(schema.observationProblems.problemId, id));

  return {
    problem: serializeProblem(problem),
    links: linkRows.map((r) => ({
      link: serializeProblemLink(r.link),
      problem: serializeProblem(r.problem),
    })),
    solutions: await solutionsForTarget(db, "problem", id),
    sourceObservations: sourceRows.map((r) => ({
      id: r.id,
      title: r.title,
      rationale: r.rationale ?? null,
      relevance: r.relevance ?? null,
    })),
    latestRun: await latestRunForTarget(db, "problem", id),
  };
}

export async function getObservationDetail(
  db: Database,
  id: string,
): Promise<ObservationDetail | null> {
  const obsRows = await db
    .select()
    .from(schema.observations)
    .where(eq(schema.observations.id, id))
    .limit(1);
  const observation = obsRows[0];
  if (!observation) return null;

  const linked = aliasedTable(schema.observations, "linked_obs");
  const linkRows = await db
    .select({ link: schema.observationLinks, observation: linked })
    .from(schema.observationLinks)
    .innerJoin(linked, eq(linked.id, schema.observationLinks.toObservationId))
    .where(eq(schema.observationLinks.fromObservationId, id));

  const synthRows = await db
    .select({
      id: schema.problems.id,
      title: schema.problems.title,
      rationale: schema.observationProblems.rationale,
      relevance: schema.observationProblems.relevance,
    })
    .from(schema.observationProblems)
    .innerJoin(schema.problems, eq(schema.problems.id, schema.observationProblems.problemId))
    .where(eq(schema.observationProblems.observationId, id));

  return {
    observation: serializeObservation(observation),
    links: linkRows.map((r) => ({
      link: serializeObservationLink(r.link),
      observation: serializeObservation(r.observation),
    })),
    solutions: await solutionsForTarget(db, "observation", id),
    synthesizedProblems: synthRows.map((r) => ({
      id: r.id,
      title: r.title,
      rationale: r.rationale ?? null,
      relevance: r.relevance ?? null,
    })),
    latestRun: await latestRunForTarget(db, "observation", id),
  };
}

/**
 * Build the knowledge graph: observation + problem + solution nodes, with
 * similarity links, `synthesizes` edges (observation → problem) and `solves`
 * edges (solution → target). Spans every accessible workspace by default;
 * `workspaceId` narrows it to a single workspace (e.g. the UI's focused view).
 */
export async function getWorkspaceGraph(
  db: Database,
  opts: { scope: AccessScope; workspaceId?: string },
): Promise<Graph> {
  const observations = await db
    .select({ id: schema.observations.id, title: schema.observations.title, status: schema.observations.status })
    .from(schema.observations)
    .where(workspaceFilter(opts.scope, schema.observations.workspaceId, opts.workspaceId));
  const problems = await db
    .select({ id: schema.problems.id, title: schema.problems.title, status: schema.problems.status })
    .from(schema.problems)
    .where(workspaceFilter(opts.scope, schema.problems.workspaceId, opts.workspaceId));

  const observationIds = observations.map((o) => o.id);
  const problemIds = problems.map((p) => p.id);

  const nodes: Graph["nodes"] = [
    ...observations.map((o) => ({ id: o.id, type: "observation" as const, label: o.title, status: o.status })),
    ...problems.map((p) => ({ id: p.id, type: "problem" as const, label: p.title, status: p.status })),
  ];
  const edges: Graph["edges"] = [];

  if (problemIds.length > 0) {
    const links = await db
      .select()
      .from(schema.problemLinks)
      .where(inArray(schema.problemLinks.fromProblemId, problemIds));
    for (const l of links) {
      edges.push({ id: l.id, source: l.fromProblemId, target: l.toProblemId, kind: l.kind, weight: l.similarity ?? null });
    }
  }

  if (observationIds.length > 0) {
    const links = await db
      .select()
      .from(schema.observationLinks)
      .where(inArray(schema.observationLinks.fromObservationId, observationIds));
    for (const l of links) {
      edges.push({ id: l.id, source: l.fromObservationId, target: l.toObservationId, kind: l.kind, weight: l.similarity ?? null });
    }

    // synthesis edges: observation → problem
    const synth = await db
      .select()
      .from(schema.observationProblems)
      .where(inArray(schema.observationProblems.observationId, observationIds));
    for (const s of synth) {
      edges.push({
        id: `synth_${s.observationId}_${s.problemId}`,
        source: s.observationId,
        target: s.problemId,
        kind: "synthesizes",
        weight: s.relevance ?? null,
      });
    }
  }

  // Solutions attached to any of this workspace's observations/problems.
  const targetIds = [...observationIds, ...problemIds];
  if (targetIds.length > 0) {
    const solRows = await db
      .select({ solution: schema.solutions, link: schema.solutionLinks })
      .from(schema.solutionLinks)
      .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
      .where(inArray(schema.solutionLinks.targetId, targetIds));

    const seenSolutions = new Set<string>();
    for (const { solution, link } of solRows) {
      if (!seenSolutions.has(solution.id)) {
        seenSolutions.add(solution.id);
        nodes.push({ id: solution.id, type: "solution", label: solution.body.slice(0, 60), status: solution.status });
      }
      edges.push({
        id: `solves_${solution.id}_${link.targetId}`,
        source: solution.id,
        target: link.targetId,
        kind: "solves",
        weight: null,
      });
    }
  }

  return { nodes, edges };
}
