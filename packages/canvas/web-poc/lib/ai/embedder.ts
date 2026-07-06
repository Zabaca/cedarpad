import { embed, type EmbeddingModel } from "ai";
import type { Embedder, EmbeddingInputType } from "./types.js";

/**
 * Voyage AI embedder (e.g. `voyage-3.5-lite`) over the REST API — workerd-native
 * (plain `fetch`, no SDK). `inputType` maps to Voyage's `input_type` so stored
 * documents and search queries are encoded asymmetrically. `dimensions` requests
 * a Matryoshka output size (voyage-3.5-lite: 256/512/1024/2048) and MUST match
 * the `F32_BLOB(N)` column.
 */
export function createVoyageEmbedder(
  apiKey: string,
  modelId: string,
  dimensions: number,
): Embedder {
  return {
    model: modelId,
    async embed(text: string, inputType?: EmbeddingInputType): Promise<number[]> {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: [text],
          model: modelId,
          input_type: inputType ?? null,
          output_dimension: dimensions,
        }),
      });
      if (!res.ok) {
        throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      const embedding = json.data?.[0]?.embedding;
      if (!embedding) throw new Error("Voyage embeddings: empty response");
      return embedding;
    },
  };
}

/** Real embedder backed by an AI SDK embedding model. */
export function createAiEmbedder(model: EmbeddingModel<string>, modelId: string): Embedder {
  return {
    model: modelId,
    async embed(text: string): Promise<number[]> {
      const { embedding } = await embed({ model, value: text });
      return embedding;
    },
  };
}

/**
 * Deterministic local embedder — no network, no API key. Hashes tokens into a
 * fixed-dimension bag-of-words vector and L2-normalizes. Useful for local dev
 * and tests where semantic quality is irrelevant but reproducibility matters.
 */
export function createHashEmbedder(dimensions: number, modelId = "local-hash-v1"): Embedder {
  return {
    model: modelId,
    async embed(text: string): Promise<number[]> {
      const vec = new Array(dimensions).fill(0);
      const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const tok of tokens) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const idx = Math.abs(h) % dimensions;
        vec[idx] += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    },
  };
}
