import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AiModelConfig, AiProvider } from "../config/index.js";
import type { EmbeddingModel, LanguageModel } from "ai";

export interface ProviderKeys {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Cloudflare Workers AI binding, when provider === "workers-ai". */
  AI?: unknown;
}

function requireKey(key: string | undefined, provider: AiProvider): string {
  if (!key) throw new Error(`Missing API key for provider "${provider}"`);
  return key;
}

/** Build the chat/reasoning model for the active provider. */
export function createChatModel(config: AiModelConfig, keys: ProviderKeys): LanguageModel {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: requireKey(keys.ANTHROPIC_API_KEY, "anthropic") })(
        config.chatModel,
      );
    case "openai":
      return createOpenAI({ apiKey: requireKey(keys.OPENAI_API_KEY, "openai") })(config.chatModel);
    case "workers-ai":
      throw new Error(
        "workers-ai chat provider requires the `workers-ai-provider` package and the AI binding; not wired in this build.",
      );
    case "voyage":
      throw new Error("Voyage is an embeddings-only provider; it has no chat model.");
  }
}

/** Build the embedding model for the configured embedding provider. */
export function createEmbeddingModel(
  config: AiModelConfig,
  keys: ProviderKeys,
): EmbeddingModel<string> {
  switch (config.embeddingProvider) {
    case "openai":
      return createOpenAI({ apiKey: requireKey(keys.OPENAI_API_KEY, "openai") }).textEmbeddingModel(
        config.embeddingModel,
      );
    case "anthropic":
      throw new Error("Anthropic does not provide an embeddings API; use openai or voyage.");
    case "workers-ai":
      throw new Error(
        "workers-ai embedding provider requires the `workers-ai-provider` package; not wired in this build.",
      );
    case "voyage":
      // Voyage is not an AI-SDK EmbeddingModel — it's used directly via
      // `createVoyageEmbedder` in worker/agent.ts (REST, workerd-native).
      throw new Error("Voyage embeddings use createVoyageEmbedder, not the AI SDK.");
  }
}
