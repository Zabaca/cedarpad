/** How a record was produced (mirrors the contract's `Origin`). */
export type SolutionOrigin = "reused" | "synthesized" | "research";

export interface Embedder {
  readonly model: string;
  /**
   * Embed text into a vector. `inputType` lets asymmetric models (e.g. Voyage)
   * encode stored documents and search queries differently for better retrieval;
   * embedders that don't distinguish simply ignore it.
   */
  embed(text: string, inputType?: EmbeddingInputType): Promise<number[]>;
}

/** Asymmetric embedding hint: a stored record vs. a search query. */
export type EmbeddingInputType = "document" | "query";
