/** Link kinds the agent can assign between two entities. */
export type LinkKind = "identical" | "partial" | "related" | "unrelated";
export type SolutionOrigin = "reused" | "synthesized" | "research";
export type Urgency = "low" | "medium" | "high" | "critical";

/** A minimal entity (observation or problem) the agent reasons over. */
export interface EntityInput {
  id: string;
  title: string;
  body: string;
  /** Optional concrete impact; folded into the embedding text when present. */
  impact?: string | null;
}

/** Back-compat alias — the classifier/synthesizer historically named this `ProblemInput`. */
export type ProblemInput = EntityInput;

export interface Candidate extends EntityInput {
  /** Cosine similarity (0..1) from the vector retrieval step. */
  similarity: number;
}

export interface Classification {
  candidateId: string;
  kind: LinkKind;
  /** Model confidence 0..1. */
  confidence: number;
  rationale: string;
}

export interface SynthesisResult {
  body: string;
  origin: SolutionOrigin;
  /** Ids of existing solutions reused, if any. */
  reusedSolutionIds: string[];
}

/**
 * A problem drafted from a cluster of observations. The agent proposes the
 * specific framing (title/body), the impact it calls out, its urgency, and how
 * a solution should be structured; a human can override any of these.
 */
export interface ProblemDraft {
  title: string;
  body: string;
  impact: string;
  urgency: Urgency;
  solutionDirection: string;
}

export interface ReuseSolution {
  id: string;
  body: string;
  /** The problem this solution is attached to (for context). */
  problemId: string;
}

/**
 * Compressed surrounding-graph context for one linked problem: its solutions
 * and how it relates to the problem under synthesis. Read straight from stored
 * rows (no LLM), so it is cheap to assemble and lets the agent reuse/adapt
 * prior work instead of re-deriving it.
 */
export interface GraphContextItem {
  problemId: string;
  title: string;
  /** Hop distance from the problem under synthesis (1 = directly linked). */
  depth: number;
  solutions: { body: string; status: string; origin: string }[];
}

/** Reasoning port. Real impl wraps the AI SDK; tests inject a fake. */
export interface Reasoner {
  classify(input: {
    problem: EntityInput;
    candidates: Candidate[];
  }): Promise<Classification[]>;
  synthesize(input: {
    problem: EntityInput;
    relatedSolutions: ReuseSolution[];
    /** Surrounding-graph context for the linked problems, if gathered. */
    graphContext?: GraphContextItem[];
  }): Promise<SynthesisResult>;
  /**
   * Draft a problem from a cluster of observations. `hint` carries any
   * human-provided overrides to honour (e.g. a title the user already wrote).
   */
  draftProblem(input: {
    observations: EntityInput[];
    hint?: Partial<ProblemDraft>;
  }): Promise<ProblemDraft>;
}

/** Embedding port. Real impl wraps the AI SDK; tests inject a deterministic one. */
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
