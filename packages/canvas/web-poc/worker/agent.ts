import { configuration } from "../lib/config/index.js";
import type { Database } from "../lib/db/index.js";
import {
  findSimilarObservations,
  findSimilarProblems,
  findSolvedNeighbors,
  getProblemContext,
  neighborhood,
  schema,
  searchGraph,
} from "../lib/db/index.js";
import {
  createAiEmbedder,
  createAiReasoner,
  createBridgeReasoner,
  createChatModel,
  createEmbeddingModel,
  createGraphTools,
  createHashEmbedder,
  createVoyageEmbedder,
  createHeuristicReasoner,
  createHybridReasoner,
  type Embedder,
  type GraphToolDeps,
  type PipelineConfig,
  type PipelineDeps,
  type PipelineEntity,
  type PipelinePorts,
  type Reasoner,
} from "../lib/ai/index.js";
import { and, eq, inArray } from "drizzle-orm";
import { getClusterSummary } from "./cluster.js";
import type { Bindings } from "./context.js";
import { publish, workspaceChannel } from "./realtime.js";

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/**
 * Resolve the find-similar recency window (config-gated, off by default) into an
 * absolute cutoff `Date`, or `undefined` to scan the full corpus. See
 * `SimilarityConfig.recencyWindowMs` and `docs/SIMILARITY_SCALING.md`.
 */
function similarityRecencyCutoff(): Date | undefined {
  const windowMs = configuration.similarity.recencyWindowMs;
  return windowMs ? new Date(Date.now() - windowMs) : undefined;
}

/** Drizzle-backed implementation of the agent pipelines' side-effect ports. */
export function createAgentPorts(db: Database, env: Bindings): PipelinePorts {
  // Captured from the first entity the pipeline touches so realtime events can
  // be published on the right workspace channel.
  let workspaceId: string | null = null;

  return {
    /* ---- problem intake ---- */
    async getProblem(id): Promise<PipelineEntity | null> {
      const rows = await db
        .select({
          id: schema.problems.id,
          workspaceId: schema.problems.workspaceId,
          title: schema.problems.title,
          body: schema.problems.body,
          impact: schema.problems.impact,
        })
        .from(schema.problems)
        .where(eq(schema.problems.id, id))
        .limit(1);
      const p = rows[0];
      if (!p) return null;
      workspaceId = p.workspaceId;
      return p;
    },

    async setProblemEmbedding(problemId, embedding, model) {
      await db
        .update(schema.problems)
        .set({ embedding, embeddingModel: model })
        .where(eq(schema.problems.id, problemId));
    },

    async findSimilarProblems({ embedding, topK, excludeId }) {
      return findSimilarProblems(db, {
        queryVector: embedding,
        topK,
        excludeProblemId: excludeId,
        since: similarityRecencyCutoff(),
      });
    },

    async getSolutionsForProblems(problemIds) {
      if (problemIds.length === 0) return [];
      const rows = await db
        .select({
          id: schema.solutions.id,
          body: schema.solutions.body,
          problemId: schema.solutionLinks.targetId,
        })
        .from(schema.solutionLinks)
        .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
        .where(
          and(
            eq(schema.solutionLinks.targetKind, "problem"),
            inArray(schema.solutionLinks.targetId, problemIds),
          ),
        );
      return rows;
    },

    async getNeighborhoodContext(problemIds, maxItems) {
      if (problemIds.length === 0) return [];
      const ids = problemIds.slice(0, maxItems);
      const titleRows = await db
        .select({ id: schema.problems.id, title: schema.problems.title })
        .from(schema.problems)
        .where(inArray(schema.problems.id, ids));
      const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

      const solRows = await db
        .select({
          problemId: schema.solutionLinks.targetId,
          body: schema.solutions.body,
          status: schema.solutions.status,
          origin: schema.solutions.origin,
        })
        .from(schema.solutionLinks)
        .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
        .where(
          and(
            eq(schema.solutionLinks.targetKind, "problem"),
            inArray(schema.solutionLinks.targetId, ids),
          ),
        );
      const byProblem = new Map<string, { body: string; status: string; origin: string }[]>();
      for (const r of solRows) {
        const arr = byProblem.get(r.problemId) ?? [];
        arr.push({ body: r.body, status: r.status, origin: r.origin });
        byProblem.set(r.problemId, arr);
      }

      return ids.map((id) => ({
        problemId: id,
        title: titleById.get(id) ?? id,
        depth: 1,
        solutions: byProblem.get(id) ?? [],
      }));
    },

    async saveSolution({ body, origin, targetKind, targetId }) {
      const id = newId("sol");
      await db
        .insert(schema.solutions)
        .values({ id, body, origin: origin as (typeof schema.solutionOrigin)[number] });
      await db.insert(schema.solutionLinks).values({ solutionId: id, targetKind, targetId });
      return id;
    },

    /* ---- observation intake ---- */
    async getObservation(id): Promise<PipelineEntity | null> {
      const rows = await db
        .select({
          id: schema.observations.id,
          workspaceId: schema.observations.workspaceId,
          title: schema.observations.title,
          body: schema.observations.body,
          impact: schema.observations.impact,
        })
        .from(schema.observations)
        .where(eq(schema.observations.id, id))
        .limit(1);
      const o = rows[0];
      if (!o) return null;
      workspaceId = o.workspaceId;
      return o;
    },

    async setObservationEmbedding(observationId, embedding, model) {
      await db
        .update(schema.observations)
        .set({ embedding, embeddingModel: model })
        .where(eq(schema.observations.id, observationId));
    },

    async findSimilarObservations({ embedding, topK, excludeId }) {
      return findSimilarObservations(db, {
        queryVector: embedding,
        topK,
        excludeObservationId: excludeId,
        since: similarityRecencyCutoff(),
      });
    },

    async saveObservationLink(link) {
      await db.insert(schema.observationLinks).values({
        id: newId("olink"),
        fromObservationId: link.fromId,
        toObservationId: link.toId,
        kind: link.kind,
        similarity: link.similarity,
        rationale: link.rationale,
        createdBy: "agent",
      });
    },

    async saveProblemLink(link) {
      await db.insert(schema.problemLinks).values({
        id: newId("link"),
        fromProblemId: link.fromId,
        toProblemId: link.toId,
        kind: link.kind,
        similarity: link.similarity,
        rationale: link.rationale,
        createdBy: "agent",
      });
    },

    /* ---- synthesis ---- */
    async getObservationsByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select({
          id: schema.observations.id,
          workspaceId: schema.observations.workspaceId,
          title: schema.observations.title,
          body: schema.observations.body,
          impact: schema.observations.impact,
        })
        .from(schema.observations)
        .where(inArray(schema.observations.id, ids));
      if (rows[0]) workspaceId = rows[0].workspaceId;
      return rows;
    },

    async createProblemFromDraft({ workspaceId: ws, draft, createdBy, projectTags }) {
      const id = newId("prob");
      workspaceId = ws;
      await db.insert(schema.problems).values({
        id,
        workspaceId: ws,
        title: draft.title,
        body: draft.body,
        impact: draft.impact,
        urgency: draft.urgency,
        solutionDirection: draft.solutionDirection,
        source: "agent",
        createdBy,
        projectTags: projectTags ?? [],
      });
      return id;
    },

    async linkObservationsToProblem(problemId, observationIds, rationale) {
      if (observationIds.length === 0) return;
      await db.insert(schema.observationProblems).values(
        observationIds.map((observationId) => ({
          observationId,
          problemId,
          rationale,
          createdBy: "agent" as const,
        })),
      );
      await db
        .update(schema.observations)
        .set({ status: "synthesized" })
        .where(inArray(schema.observations.id, observationIds));
    },

    /* ---- runs + realtime ---- */
    async startRun({ kind, target, providerModel }) {
      const id = newId("run");
      await db.insert(schema.agentRuns).values({
        id,
        kind,
        targetKind: target.kind,
        targetId: target.id,
        status: "running",
        providerModel,
      });
      return id;
    },

    async finishRun(runId, result) {
      await db
        .update(schema.agentRuns)
        .set({ status: result.status, steps: result.steps, error: result.error ?? null })
        .where(eq(schema.agentRuns.id, runId));
    },

    async publish(event) {
      if (!workspaceId) return;
      await publish(env, workspaceChannel(workspaceId), { type: event.type, payload: event.payload });
    },
  };
}

/** Pick the embedder: the configured provider when its key exists, else the
 * deterministic local hash (offline/dev fallback). */
export function createEmbedder(env: Bindings): Embedder {
  const { ai } = configuration;
  if (ai.embeddingProvider === "voyage" && env.VOYAGE_API_KEY) {
    return createVoyageEmbedder(env.VOYAGE_API_KEY, ai.embeddingModel, ai.embeddingDimensions);
  }
  if (ai.embeddingProvider === "openai" && env.OPENAI_API_KEY) {
    return createAiEmbedder(
      createEmbeddingModel(ai, { OPENAI_API_KEY: env.OPENAI_API_KEY }),
      ai.embeddingModel,
    );
  }
  return createHashEmbedder(ai.embeddingDimensions);
}

/**
 * Drizzle-backed implementations of the in-process graph tools. Pair with
 * `createGraphTools` from `@cedarpad/ai` to give an LLM agent callable, bounded,
 * read-only access to the stored graph. The graph spans every workspace, so
 * these reads surface reusable prior work from any tenant.
 */
export function createGraphToolDeps(db: Database, env: Bindings): GraphToolDeps {
  const embedder = createEmbedder(env);
  const g = configuration.graph;

  return {
    async searchGraph({ query, k }) {
      const queryVector = await embedder.embed(query, "query");
      return searchGraph(db, {
        queryVector,
        topK: k ?? g.defaultK,
      });
    },
    async getProblemContext({ problemId }) {
      return getProblemContext(db, problemId);
    },
    async expandNeighborhood({ problemId, hops, maxNodes }) {
      return neighborhood(db, {
        rootId: problemId,
        hops: Math.min(hops ?? g.defaultHops, g.maxHops),
        maxNodes: Math.min(maxNodes ?? g.maxNodes, g.maxNodes),
      });
    },
    async findSolvedNeighbors({ problemId }) {
      return findSolvedNeighbors(db, {
        rootId: problemId,
        hops: g.defaultHops,
        maxNodes: g.maxNodes,
      });
    },
    async getClusterSummary({ problemId }) {
      return getClusterSummary(db, env, problemId);
    },
  };
}

/** True when the active chat provider has a key — i.e. real LLM, not heuristic. */
function hasChatKey(env: Bindings): boolean {
  const { ai } = configuration;
  return Boolean(
    (ai.provider === "anthropic" && env.ANTHROPIC_API_KEY) ||
      (ai.provider === "openai" && env.OPENAI_API_KEY),
  );
}

/** Label identifying which model/path served a run ("heuristic" with no key). */
export function providerModelLabel(env: Bindings): string {
  const { ai } = configuration;
  if (env.AI_BRIDGE_DIR) return "bridge:manual";
  return hasChatKey(env) ? `${ai.provider}:${ai.chatModel}` : "heuristic";
}

/**
 * Pick the reasoner: real LLM when the provider key exists, else heuristic.
 * When `graph` is supplied (a db handle) and a key is present, the LLM reasoner
 * gets read-only, cross-workspace graph tools it can call during synthesis.
 */
export function createReasoner(env: Bindings, graph?: { db: Database }): Reasoner {
  const { ai, similarity } = configuration;

  // Manual bridge takes precedence over any key: route every LLM call to the
  // file queue an operator (or Claude Code) drains. Dev/node-only.
  if (env.AI_BRIDGE_DIR) {
    return createBridgeReasoner({
      dir: env.AI_BRIDGE_DIR,
      timeoutMs: env.AI_BRIDGE_TIMEOUT_MS ? Number(env.AI_BRIDGE_TIMEOUT_MS) : undefined,
    });
  }

  const keys = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY };
  const heuristic = () =>
    createHeuristicReasoner({
      identicalThreshold: similarity.identicalThreshold,
      partialThreshold: similarity.partialThreshold,
    });

  // No key, or explicitly heuristic mode ⇒ never call the LLM.
  if (!hasChatKey(env) || similarity.classificationMode === "heuristic") {
    return heuristic();
  }

  const tools = graph ? createGraphTools(createGraphToolDeps(graph.db, env)) : undefined;
  const llm = createAiReasoner(createChatModel(ai, keys), { tools });

  // Hybrid: heuristic-classify confident candidates, send only the ambiguous
  // band `[partialThreshold, identicalThreshold)` to the LLM; synthesis stays LLM.
  if (similarity.classificationMode === "hybrid") {
    return createHybridReasoner({
      heuristic: heuristic(),
      llm,
      band: { lower: similarity.partialThreshold, upper: similarity.identicalThreshold },
    });
  }
  return llm;
}

/**
 * Assemble everything the agent pipelines need for one pass. This is the single
 * wiring point: ports, reasoner (with cross-workspace graph tools when an LLM
 * key is present), embedder, and run config.
 */
export function createPipelineDeps(db: Database, env: Bindings): PipelineDeps {
  return {
    ports: createAgentPorts(db, env),
    reasoner: createReasoner(env, { db }),
    embedder: createEmbedder(env),
    config: {
      topK: configuration.similarity.topK,
      providerModel: providerModelLabel(env),
    } satisfies PipelineConfig,
  };
}
