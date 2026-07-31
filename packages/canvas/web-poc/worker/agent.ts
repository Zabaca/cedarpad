import { configuration } from "../lib/config/index.js";
import {
  createAiEmbedder,
  createEmbeddingModel,
  createHashEmbedder,
  createVoyageEmbedder,
  type Embedder,
} from "../lib/ai/index.js";
import type { Bindings } from "./context.js";

/**
 * What survives of the intake pipeline (ADR-0024): the embedder factory, and the
 * label that tells tooling which provider path is live. Nothing calls the
 * embedder on the write path any more — the Notebook stores what it is given —
 * but the factory is the piece a future search slice needs, so it stays.
 */

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
