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
 * The graph knowledge layer is confined to one workspace. The hierarchy is
 * `workspace → observations → problems → solutions`: observations are loose,
 * workspace-local captures; many observations synthesize into a problem, and a
 * problem (or an observation) carries solutions. Every read — listing, traversal
 * and problem context alike — filters by the caller's active workspace, which is
 * resolved from their token and never a request parameter (ADR-0024).
 */

export interface GraphConfig {
  /** Default traversal depth for `neighborhood`/`expandNeighborhood`. */
  readonly defaultHops: number;
  /** Hard cap on traversal depth — bounds latency regardless of caller input. */
  readonly maxHops: number;
  /** Hard cap on nodes materialised by a traversal — keeps context small. */
  readonly maxNodes: number;
}

export interface AppConfiguration {
  readonly ai: AiModelConfig;
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
  graph: {
    defaultHops: 2,
    maxHops: 3,
    maxNodes: 100,
  },
  defaultPageSize: 25,
};
