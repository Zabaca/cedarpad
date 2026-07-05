import type {
  Candidate,
  Classification,
  Embedder,
  EntityInput,
  GraphContextItem,
  LinkKind,
  ProblemDraft,
  Reasoner,
  ReuseSolution,
} from "./types.js";

/** An observation/problem the pipeline operates on, with its tenant. */
export interface PipelineEntity extends EntityInput {
  workspaceId: string;
}
/** @deprecated use {@link PipelineEntity}. */
export type PipelineProblem = PipelineEntity;

/**
 * Build the text fed to the embedder. Title + body always; impact is appended
 * when present so two records that share an impact land closer in vector space
 * (and thus cluster/link sooner). Mirrors what {@link EntityInput} carries.
 */
export function embedText(entity: Pick<EntityInput, "title" | "body" | "impact">): string {
  const base = `${entity.title}\n\n${entity.body}`;
  return entity.impact ? `${base}\n\n${entity.impact}` : base;
}

export interface SavedLink {
  fromId: string;
  toId: string;
  kind: Exclude<LinkKind, "unrelated">;
  similarity: number | null;
  rationale: string;
}

/** A run target: an observation or a problem. */
export type RunTarget = { kind: "observation" | "problem"; id: string };

/**
 * Side-effect ports the pipelines drive. Implemented with Drizzle in apps/api.
 */
export interface PipelinePorts {
  /* ---- problem intake ---- */
  getProblem(id: string): Promise<PipelineEntity | null>;
  setProblemEmbedding(problemId: string, embedding: number[], model: string): Promise<void>;
  /** Nearest problems across every workspace — identicalness is cross-tenant. */
  findSimilarProblems(params: {
    embedding: number[];
    topK: number;
    excludeId: string;
  }): Promise<Candidate[]>;
  saveProblemLink(link: SavedLink): Promise<void>;
  getSolutionsForProblems(problemIds: string[]): Promise<ReuseSolution[]>;
  /** Compressed surrounding-graph context for linked problems (no LLM). */
  getNeighborhoodContext(problemIds: string[], maxItems: number): Promise<GraphContextItem[]>;
  saveSolution(input: {
    body: string;
    origin: string;
    targetKind: "observation" | "problem";
    targetId: string;
  }): Promise<string>;

  /* ---- observation intake ---- */
  getObservation(id: string): Promise<PipelineEntity | null>;
  setObservationEmbedding(observationId: string, embedding: number[], model: string): Promise<void>;
  /** Nearest observations across every workspace — identicalness is cross-tenant. */
  findSimilarObservations(params: {
    embedding: number[];
    topK: number;
    excludeId: string;
  }): Promise<Candidate[]>;
  saveObservationLink(link: SavedLink): Promise<void>;

  /* ---- synthesis ---- */
  getObservationsByIds(ids: string[]): Promise<PipelineEntity[]>;
  createProblemFromDraft(input: {
    workspaceId: string;
    draft: ProblemDraft;
    createdBy: string | null;
    projectTags?: string[];
  }): Promise<string>;
  /** Mark observations as synthesized into a problem + record the synthesis edge. */
  linkObservationsToProblem(
    problemId: string,
    observationIds: string[],
    rationale: string,
  ): Promise<void>;

  /* ---- runs + realtime ---- */
  startRun(input: {
    kind: "observation_intake" | "problem_intake" | "synthesis";
    target: RunTarget;
    providerModel: string;
  }): Promise<string>;
  finishRun(
    runId: string,
    result: { status: "completed" | "failed"; steps: unknown[]; error?: string },
  ): Promise<void>;
  publish(event: { type: string; target: RunTarget; payload?: unknown }): Promise<void>;
}

export interface PipelineConfig {
  topK: number;
  providerModel: string;
  /** Max linked problems whose surrounding context is fed into synthesis. */
  graphContextMaxItems?: number;
}

export interface PipelineDeps {
  ports: PipelinePorts;
  reasoner: Reasoner;
  embedder: Embedder;
  config: PipelineConfig;
}

export interface PipelineResult {
  runId: string;
  links: SavedLink[];
  solutionId: string | null;
}

export interface SynthesisPipelineResult extends PipelineResult {
  problemId: string;
}

const REUSABLE: ReadonlySet<LinkKind> = new Set<LinkKind>(["identical", "partial"]);

/** Turn the agent's classifications into the links to persist. */
function linksFromClassifications(
  fromId: string,
  classifications: Classification[],
  candidates: Candidate[],
): { links: SavedLink[]; reusableIds: string[] } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const links: SavedLink[] = [];
  const reusableIds: string[] = [];
  for (const cls of classifications) {
    if (cls.kind === "unrelated") continue;
    const cand = byId.get(cls.candidateId);
    if (!cand) continue;
    links.push({
      fromId,
      toId: cls.candidateId,
      kind: cls.kind,
      similarity: cand.similarity,
      rationale: cls.rationale,
    });
    if (REUSABLE.has(cls.kind)) reusableIds.push(cls.candidateId);
  }
  return { links, reusableIds };
}

/**
 * Problem intake: embed → retrieve similar problems → classify → persist links
 * → synthesize/reuse a solution → record the run → publish. A problem is
 * expected to be resolved, so a solution is always synthesized.
 */
export async function runAgentPipeline(
  deps: PipelineDeps,
  problemId: string,
): Promise<PipelineResult> {
  const { ports, reasoner, embedder, config } = deps;
  const steps: unknown[] = [];
  const target: RunTarget = { kind: "problem", id: problemId };
  const runId = await ports.startRun({ kind: "problem_intake", target, providerModel: config.providerModel });

  try {
    const problem = await ports.getProblem(problemId);
    if (!problem) throw new Error(`Problem ${problemId} not found`);

    const embedding = await embedder.embed(embedText(problem));
    await ports.setProblemEmbedding(problemId, embedding, embedder.model);
    steps.push({ step: "embed", model: embedder.model, dims: embedding.length });

    const retrieveStart = Date.now();
    const candidates = await ports.findSimilarProblems({
      embedding,
      topK: config.topK,
      excludeId: problemId,
    });
    // `ms` is the app-side early-warning signal for the brute-force scan: it
    // grows with the embedded-corpus size and flags the page-cache cliff before
    // it bites. Pair it with Turso's rows-read dashboard (docs/SIMILARITY_SCALING.md).
    steps.push({ step: "retrieve", count: candidates.length, ms: Date.now() - retrieveStart });

    const classifications = await reasoner.classify({ problem, candidates });
    steps.push({ step: "classify", classifications });

    const { links, reusableIds } = linksFromClassifications(problemId, classifications, candidates);
    for (const link of links) await ports.saveProblemLink(link);

    const relatedSolutions = reusableIds.length
      ? await ports.getSolutionsForProblems(reusableIds)
      : [];

    const linkedProblemIds = links.map((l) => l.toId);
    const graphContext = linkedProblemIds.length
      ? await ports.getNeighborhoodContext(linkedProblemIds, config.graphContextMaxItems ?? 20)
      : [];
    steps.push({ step: "context", count: graphContext.length });

    const synthesis = await reasoner.synthesize({ problem, relatedSolutions, graphContext });
    const solutionId = await ports.saveSolution({
      body: synthesis.body,
      origin: synthesis.origin,
      targetKind: "problem",
      targetId: problemId,
    });
    steps.push({ step: "synthesize", origin: synthesis.origin, solutionId });

    await ports.finishRun(runId, { status: "completed", steps });
    await ports.publish({ type: "problem.processed", target, payload: { links, solutionId } });

    return { runId, links, solutionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ step: "error", message });
    await ports.finishRun(runId, { status: "failed", steps, error: message });
    await ports.publish({ type: "problem.failed", target, payload: { error: message } });
    throw err;
  }
}

/**
 * Observation intake: embed → retrieve similar observations → classify →
 * persist similarity links. Observations do not get an auto-synthesized
 * solution — they are loose records that may later cluster into a problem.
 */
export async function runObservationPipeline(
  deps: PipelineDeps,
  observationId: string,
): Promise<PipelineResult> {
  const { ports, reasoner, embedder, config } = deps;
  const steps: unknown[] = [];
  const target: RunTarget = { kind: "observation", id: observationId };
  const runId = await ports.startRun({
    kind: "observation_intake",
    target,
    providerModel: config.providerModel,
  });

  try {
    const observation = await ports.getObservation(observationId);
    if (!observation) throw new Error(`Observation ${observationId} not found`);

    const embedding = await embedder.embed(embedText(observation));
    await ports.setObservationEmbedding(observationId, embedding, embedder.model);
    steps.push({ step: "embed", model: embedder.model, dims: embedding.length });

    const retrieveStart = Date.now();
    const candidates = await ports.findSimilarObservations({
      embedding,
      topK: config.topK,
      excludeId: observationId,
    });
    // See runAgentPipeline: `ms` tracks brute-force scan cost as the corpus grows.
    steps.push({ step: "retrieve", count: candidates.length, ms: Date.now() - retrieveStart });

    const classifications = await reasoner.classify({ problem: observation, candidates });
    steps.push({ step: "classify", classifications });

    const { links } = linksFromClassifications(observationId, classifications, candidates);
    for (const link of links) await ports.saveObservationLink(link);

    await ports.finishRun(runId, { status: "completed", steps });
    await ports.publish({ type: "observation.processed", target, payload: { links } });

    return { runId, links, solutionId: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ step: "error", message });
    await ports.finishRun(runId, { status: "failed", steps, error: message });
    await ports.publish({ type: "observation.failed", target, payload: { error: message } });
    throw err;
  }
}

/**
 * Assistive synthesis: take a set of observations, have the agent draft a
 * problem from them (honouring any human overrides), create that problem,
 * record the synthesis edges, then run the full problem-intake pipeline so the
 * new problem is embedded, linked, and given a candidate solution.
 */
export async function synthesizeProblemFromObservations(
  deps: PipelineDeps,
  params: {
    workspaceId: string;
    observationIds: string[];
    createdBy: string | null;
    hint?: Partial<ProblemDraft>;
    projectTags?: string[];
  },
): Promise<SynthesisPipelineResult> {
  const { ports, reasoner } = deps;
  const observations = await ports.getObservationsByIds(params.observationIds);
  if (observations.length === 0) throw new Error("No observations found to synthesize from");

  const draft = await reasoner.draftProblem({ observations, hint: params.hint });
  const problemId = await ports.createProblemFromDraft({
    workspaceId: params.workspaceId,
    draft,
    createdBy: params.createdBy,
    projectTags: params.projectTags,
  });
  await ports.linkObservationsToProblem(
    problemId,
    observations.map((o) => o.id),
    `Synthesized from ${observations.length} observation(s)`,
  );

  // Embed/link/solve the freshly-created problem like any other intake.
  const result = await runAgentPipeline(deps, problemId);
  return { ...result, problemId };
}

export type { Candidate, Classification };
