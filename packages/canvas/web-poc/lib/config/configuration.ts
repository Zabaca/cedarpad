/**
 * Configuration-as-code.
 *
 * Non-secret, version-controlled settings for the whole platform. Secrets
 * (API keys, tokens) live in SOPS `secrets.yaml` and arrive at runtime through
 * `env.ts`. Everything here is a plain constant so it is fully type-checked and
 * diffable — no database-backed configuration.
 */

/** Supported AI providers. The platform is provider-agnostic via the Vercel AI SDK. */
export type AiProvider = "anthropic" | "openai" | "workers-ai" | "voyage";

export interface AiModelConfig {
  /** Active provider for chat/agent reasoning. */
  readonly provider: AiProvider;
  /** Chat/reasoning model id for the active provider. */
  readonly chatModel: string;
  /** Provider used for embeddings (may differ from the chat provider). */
  readonly embeddingProvider: AiProvider;
  /** Embedding model id. */
  readonly embeddingModel: string;
  /**
   * Embedding vector dimensions. This is FIXED into the libSQL `F32_BLOB(N)`
   * column — changing it requires a re-embed migration. Matches the active
   * embedding model's output (Voyage `voyage-3.5-lite` → 1024 by default).
   */
  readonly embeddingDimensions: number;
}

/**
 * How link classification spends tokens at intake:
 * - `llm`: every retrieved candidate is classified by the LLM (highest quality, most tokens).
 * - `hybrid`: the 0-token heuristic handles candidates that are confidently identical
 *   (≥ `identicalThreshold`) or confidently below `partialThreshold`; only the ambiguous
 *   middle band `[partialThreshold, identicalThreshold)` is sent to the LLM. Cuts intake tokens.
 * - `heuristic`: never calls the LLM (also the automatic fallback when no provider key is set).
 */
export type ClassificationMode = "llm" | "hybrid" | "heuristic";

export interface SimilarityConfig {
  /** How many nearest neighbours to retrieve for the agent to consider. */
  readonly topK: number;
  /** Cosine similarity (1 - distance) at/above which two problems are "identical". */
  readonly identicalThreshold: number;
  /** Cosine similarity at/above which two problems are "partially similar". */
  readonly partialThreshold: number;
  /**
   * Write-time classification strategy. The ambiguous LLM band reuses the
   * thresholds above: `[partialThreshold, identicalThreshold)`. With no provider
   * key the pipeline always falls back to the heuristic regardless of this value.
   */
  readonly classificationMode: ClassificationMode;
  /**
   * Recency window for the find-similar scan, in milliseconds. When set, intake
   * only compares against rows created within this window — fewer rows scanned,
   * which on Turso means fewer metered reads (see `docs/SIMILARITY_SCALING.md`).
   * `null` (the default) scans the full corpus. Flip this on once the corpus
   * grows enough that the Turso rows-read signal warrants it; it trades some
   * recall against older records for cost.
   */
  readonly recencyWindowMs: number | null;
}

/**
 * The graph knowledge layer is confined to one workspace. The hierarchy is
 * `workspace → observations → problems → solutions`: observations are loose,
 * workspace-local captures; many observations synthesize into a problem, and a
 * problem (or an observation) carries solutions. Every read — listing, traversal
 * and problem context alike — filters by the caller's active workspace, which is
 * resolved from their token and never a request parameter (ADR-0024).
 */

/**
 * Tier 3 cached community summaries. A cluster summary is computed lazily and
 * cached keyed by a hash of the cluster's membership, so it is recomputed only
 * when the cluster changes (TTL is a backstop). Gated by `enabled`.
 */
export interface ClusterSummaryConfig {
  /** Master switch for Tier 3 summaries. When false the endpoint/tool short-circuit. */
  readonly enabled: boolean;
  /** Backstop expiry for a cached summary even if membership is unchanged (ms). */
  readonly ttlMs: number;
  /** Cap on cluster members folded into one summary — bounds summarization cost. */
  readonly maxMembers: number;
}

export interface GraphConfig {
  /** Default neighbours returned by `searchGraph` when the caller omits `k`. */
  readonly defaultK: number;
  /** Default traversal depth for `neighborhood`/`expandNeighborhood`. */
  readonly defaultHops: number;
  /** Hard cap on traversal depth — bounds latency regardless of caller input. */
  readonly maxHops: number;
  /** Hard cap on nodes materialised by a traversal — keeps context small. */
  readonly maxNodes: number;
  /** Tier 3 cached cluster summaries (lazy, membership-hash-keyed). */
  readonly summary: ClusterSummaryConfig;
}

export interface AppConfiguration {
  readonly ai: AiModelConfig;
  readonly similarity: SimilarityConfig;
  readonly graph: GraphConfig;
  /** Default page size for list endpoints. */
  readonly defaultPageSize: number;
}

/** voyage-3.5-lite default output dimension (Matryoshka: 256/512/1024/2048). */
export const EMBEDDING_DIMENSIONS = 1024;

export const configuration: AppConfiguration = {
  ai: {
    provider: "anthropic",
    chatModel: "claude-sonnet-4-6",
    embeddingProvider: "voyage",
    embeddingModel: "voyage-3.5-lite",
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  },
  similarity: {
    topK: 8,
    identicalThreshold: 0.92,
    partialThreshold: 0.78,
    classificationMode: "hybrid",
    recencyWindowMs: null,
  },
  graph: {
    defaultK: 8,
    defaultHops: 2,
    maxHops: 3,
    maxNodes: 100,
    summary: {
      enabled: true,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      maxMembers: 50,
    },
  },
  defaultPageSize: 25,
};
