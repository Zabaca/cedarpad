import { generateObject, generateText, Output, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { Classification, LinkKind, ProblemDraft, Reasoner } from "./types.js";

// Exported so the bridge reasoner (manual / Claude-in-the-loop mode) validates
// answers against the exact same shapes and reuses the exact same prompts.
export const ClassificationOutput = z.object({
  classifications: z.array(
    z.object({
      candidateId: z.string(),
      kind: z.enum(["identical", "partial", "related", "unrelated"]),
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
    }),
  ),
});

export const SynthesisOutput = z.object({
  body: z.string(),
  origin: z.enum(["reused", "synthesized", "research"]),
  reusedSolutionIds: z.array(z.string()),
});

export const DraftOutput = z.object({
  title: z.string(),
  body: z.string(),
  impact: z.string(),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  solutionDirection: z.string(),
});

export const DRAFT_SYSTEM = `You are a product analyst. Given a cluster of related OBSERVATIONS (loose notes about things people noticed), synthesize a single distinct PROBLEM that the pattern points to. A good problem is:
1. specific (not a vague theme),
2. calls out a concrete impact,
3. has an urgency (low/medium/high/critical),
4. describes how a solution should be structured (solutionDirection).
Write a crisp title and a body that explains the problem the observations collectively reveal. Honour any fields the human already provided.`;

export const CLASSIFY_SYSTEM = `You are a problem-deduplication analyst. Given a NEW problem and a list of CANDIDATE problems retrieved by semantic similarity, decide how each candidate relates to the new problem:
- "identical": same underlying problem, possibly reworded.
- "partial": overlapping but not the same; shares a meaningful sub-problem or root cause.
- "related": same domain/area but a distinct problem.
- "unrelated": no meaningful connection (retrieval was a false positive).
Be conservative: only use "identical" when you are confident. Return one classification per candidate.`;

export const SYNTH_SYSTEM = `You are a solutions engineer. Given a problem, any solutions from related problems, and the surrounding graph context (nearby linked problems and their solutions), produce the best candidate solution.
- If an existing related solution already solves it (possibly with minor adaptation), set origin="reused" and list the reused solution ids.
- If you combine/extend related solutions into something new, set origin="synthesized".
- If related solutions are insufficient and you rely on general knowledge/outside research, set origin="research".
Prefer reusing/adapting prior work from the graph context when it fits.
If graph tools are available, use them to explore the surrounding graph (search for similar problems, expand a problem's neighborhood, or find nearby problems that already have accepted solutions) BEFORE deciding. Then write a concrete, actionable solution body.`;

export interface AiReasonerOptions {
  /**
   * Read-only graph tools the model may call mid-reasoning during synthesis
   * (e.g. from `createGraphTools`). When omitted, synthesis is a single
   * structured-output call with no exploration.
   */
  tools?: ToolSet;
  /** Step budget for the tool loop (tool calls + the final structured output). */
  maxSteps?: number;
}

/** Real reasoner backed by an AI SDK language model via structured output. */
export function createAiReasoner(model: LanguageModel, options: AiReasonerOptions = {}): Reasoner {
  const { tools, maxSteps = 6 } = options;
  const useTools = tools != null && Object.keys(tools).length > 0;
  return {
    async classify({ problem, candidates }) {
      if (candidates.length === 0) return [];
      const { object } = await generateObject({
        model,
        schema: ClassificationOutput,
        system: CLASSIFY_SYSTEM,
        prompt: JSON.stringify({
          newProblem: { title: problem.title, body: problem.body },
          candidates: candidates.map((c) => ({
            candidateId: c.id,
            title: c.title,
            body: c.body,
            similarity: c.similarity,
          })),
        }),
      });
      return object.classifications;
    },

    async synthesize({ problem, relatedSolutions, graphContext }) {
      const prompt = JSON.stringify({
        problemId: problem.id,
        problem: { title: problem.title, body: problem.body },
        relatedSolutions: relatedSolutions.map((s) => ({ id: s.id, body: s.body })),
        graphContext: (graphContext ?? []).map((g) => ({
          problemId: g.problemId,
          title: g.title,
          depth: g.depth,
          solutions: g.solutions,
        })),
      });

      // With tools, let the model explore the graph across steps, then emit the
      // structured solution; the final structured output counts as one step.
      if (useTools) {
        const { experimental_output: output } = await generateText({
          model,
          system: SYNTH_SYSTEM,
          prompt,
          tools,
          stopWhen: stepCountIs(maxSteps),
          experimental_output: Output.object({ schema: SynthesisOutput }),
        });
        return output;
      }

      const { object } = await generateObject({
        model,
        schema: SynthesisOutput,
        system: SYNTH_SYSTEM,
        prompt,
      });
      return object;
    },

    async draftProblem({ observations, hint }) {
      const { object } = await generateObject({
        model,
        schema: DraftOutput,
        system: DRAFT_SYSTEM,
        prompt: JSON.stringify({
          observations: observations.map((o) => ({ title: o.title, body: o.body })),
          humanProvided: hint ?? {},
        }),
      });
      return { ...object, ...stripUndefined(hint) };
    },
  };
}

/** Drop undefined keys so a partial hint only overrides fields the human set. */
function stripUndefined(hint?: Partial<ProblemDraft>): Partial<ProblemDraft> {
  if (!hint) return {};
  return Object.fromEntries(Object.entries(hint).filter(([, v]) => v !== undefined));
}

export interface HeuristicThresholds {
  /** >= this cosine similarity ⇒ "identical". */
  identicalThreshold: number;
  /** >= this ⇒ "partial". */
  partialThreshold: number;
}

export interface HybridBand {
  /** Lower edge (inclusive): candidates at/above this are ambiguous. Typically `partialThreshold`. */
  lower: number;
  /** Upper edge (exclusive): candidates below this are ambiguous. Typically `identicalThreshold`. */
  upper: number;
}

/**
 * Token-saving classifier: classify confidently-similar (>= `band.upper`) and
 * confidently-dissimilar (< `band.lower`) candidates with the 0-token heuristic,
 * and send only the ambiguous middle band `[lower, upper)` to the LLM. When no
 * candidate is ambiguous the LLM is never called. Synthesis always delegates to
 * the LLM reasoner (so graph-tool exploration is preserved).
 *
 * The result order matches the input candidate order so downstream link
 * persistence is unaffected.
 */
export function createHybridReasoner(deps: {
  heuristic: Reasoner;
  llm: Reasoner;
  band: HybridBand;
}): Reasoner {
  const { heuristic, llm, band } = deps;
  const isAmbiguous = (similarity: number) => similarity >= band.lower && similarity < band.upper;

  return {
    async classify({ problem, candidates }) {
      if (candidates.length === 0) return [];

      const ambiguous = candidates.filter((c) => isAmbiguous(c.similarity));
      const confident = candidates.filter((c) => !isAmbiguous(c.similarity));

      // Heuristic is synchronous-cheap; LLM is only invoked when there is an
      // ambiguous candidate, and only sees that smaller subset.
      const [confidentResults, ambiguousResults] = await Promise.all([
        confident.length ? heuristic.classify({ problem, candidates: confident }) : [],
        ambiguous.length ? llm.classify({ problem, candidates: ambiguous }) : [],
      ]);

      const byId = new Map(
        [...confidentResults, ...ambiguousResults].map((r) => [r.candidateId, r]),
      );
      // Preserve input order; drop any candidate a reasoner failed to classify.
      return candidates.map((c) => byId.get(c.id)).filter((r): r is Classification => r != null);
    },

    synthesize(input) {
      return llm.synthesize(input);
    },

    // Drafting a problem is a reasoning-heavy task — always use the LLM.
    draftProblem(input) {
      return llm.draftProblem(input);
    },
  };
}

/**
 * No-LLM reasoner. Classifies purely from retrieval similarity and synthesizes
 * a templated solution (reusing a related solution when one exists). Lets the
 * full pipeline run with zero provider keys — useful for local dev, offline
 * tests, and graceful degradation.
 */
export function createHeuristicReasoner(thresholds: HeuristicThresholds): Reasoner {
  const { identicalThreshold, partialThreshold } = thresholds;
  const relatedThreshold = partialThreshold * 0.8;

  function kindFor(similarity: number): LinkKind {
    if (similarity >= identicalThreshold) return "identical";
    if (similarity >= partialThreshold) return "partial";
    if (similarity >= relatedThreshold) return "related";
    return "unrelated";
  }

  return {
    async classify({ candidates }) {
      return candidates.map((c) => ({
        candidateId: c.id,
        kind: kindFor(c.similarity),
        confidence: c.similarity,
        rationale: `Heuristic: cosine similarity ${c.similarity.toFixed(3)} ⇒ ${kindFor(c.similarity)}`,
      }));
    },
    async synthesize({ problem, relatedSolutions }) {
      if (relatedSolutions.length > 0) {
        const reused = relatedSolutions[0]!;
        return {
          body: `Reusing a solution from a related problem:\n\n${reused.body}`,
          origin: "reused",
          reusedSolutionIds: [reused.id],
        };
      }
      return {
        body: `No prior solution found. Investigate "${problem.title}" from first principles: reproduce, isolate the root cause, then apply a targeted fix.`,
        origin: "synthesized",
        reusedSolutionIds: [],
      };
    },
    async draftProblem({ observations, hint }) {
      // No LLM: stitch the observation titles into a templated problem draft.
      const titles = observations.map((o) => o.title).filter(Boolean);
      const lead = titles[0] ?? "Recurring issue";
      return {
        title: hint?.title ?? `Pattern: ${lead}`,
        body:
          hint?.body ??
          `Synthesized from ${observations.length} observation(s):\n` +
            observations.map((o) => `- ${o.title}: ${o.body}`).join("\n"),
        impact: hint?.impact ?? "Impact inferred from the clustered observations; review and refine.",
        urgency: hint?.urgency ?? "medium",
        solutionDirection:
          hint?.solutionDirection ??
          "Confirm the shared root cause across the observations, then apply a single targeted fix.",
      };
    },
  };
}
