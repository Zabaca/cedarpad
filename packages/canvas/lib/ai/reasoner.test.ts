import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it, mock } from "bun:test";
import { createAiReasoner, createHeuristicReasoner, createHybridReasoner } from "./reasoner.js";
import { createGraphTools, type GraphToolDeps } from "./tools.js";
import type { Candidate, ProblemInput, Reasoner } from "./types.js";

const problem: ProblemInput = { id: "p_new", title: "Login fails", body: "intermittent login failures" };

/* ------------------------------------------------------------------ *
 * Hybrid reasoner — band partitioning, order, delegation
 * ------------------------------------------------------------------ */

describe("createHybridReasoner", () => {
  const heuristic = createHeuristicReasoner({ identicalThreshold: 0.92, partialThreshold: 0.78 });
  const band = { lower: 0.78, upper: 0.92 };

  it("sends only the ambiguous band to the llm and preserves candidate order", async () => {
    const candidates: Candidate[] = [
      { id: "p_high", title: "High", body: "h", similarity: 0.95 }, // confident -> heuristic identical
      { id: "p_mid", title: "Mid", body: "m", similarity: 0.85 }, //  ambiguous -> llm
      { id: "p_low", title: "Low", body: "l", similarity: 0.4 }, //   confident -> heuristic unrelated
    ];

    let llmSaw: string[] = [];
    const llm: Reasoner = {
      async classify({ candidates: cs }) {
        llmSaw = cs.map((c) => c.id);
        return cs.map((c) => ({
          candidateId: c.id,
          kind: "partial" as const,
          confidence: 0.8,
          rationale: "llm",
        }));
      },
      async synthesize() {
        return { body: "x", origin: "synthesized", reusedSolutionIds: [] };
      },
      async draftProblem() {
        return { title: "t", body: "b", impact: "i", urgency: "medium", solutionDirection: "s" };
      },
    };

    const hybrid = createHybridReasoner({ heuristic, llm, band });
    const result = await hybrid.classify({ problem, candidates });

    expect(llmSaw).toEqual(["p_mid"]); // only the ambiguous candidate reached the llm
    expect(result.map((r) => r.candidateId)).toEqual(["p_high", "p_mid", "p_low"]); // input order
    expect(result.map((r) => r.kind)).toEqual(["identical", "partial", "unrelated"]);
  });

  it("never calls the llm when no candidate is ambiguous", async () => {
    const candidates: Candidate[] = [
      { id: "p_high", title: "High", body: "h", similarity: 0.97 },
      { id: "p_low", title: "Low", body: "l", similarity: 0.3 },
    ];
    const llm: Reasoner = {
      classify: mock(async () => {
        throw new Error("llm should not be called");
      }),
      async synthesize() {
        return { body: "x", origin: "synthesized", reusedSolutionIds: [] };
      },
      async draftProblem() {
        return { title: "t", body: "b", impact: "i", urgency: "medium", solutionDirection: "s" };
      },
    };

    const hybrid = createHybridReasoner({ heuristic, llm, band });
    const result = await hybrid.classify({ problem, candidates });

    expect(llm.classify).not.toHaveBeenCalled();
    expect(result.map((r) => r.kind)).toEqual(["identical", "unrelated"]);
  });

  it("delegates synthesis to the llm reasoner", async () => {
    const llm: Reasoner = {
      async classify() {
        return [];
      },
      async synthesize() {
        return { body: "from-llm", origin: "research", reusedSolutionIds: ["s1"] };
      },
      async draftProblem() {
        return { title: "t", body: "b", impact: "i", urgency: "medium", solutionDirection: "s" };
      },
    };
    const hybrid = createHybridReasoner({ heuristic, llm, band });
    const out = await hybrid.synthesize({ problem, relatedSolutions: [] });
    expect(out.body).toBe("from-llm");
    expect(out.origin).toBe("research");
  });
});

/* ------------------------------------------------------------------ *
 * createAiReasoner driven by MockLanguageModelV2 — deterministic CI
 * coverage for the structured-output classify path and the tool loop.
 * ------------------------------------------------------------------ */

const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

/** A `doGenerate` response whose single text part is the JSON of `obj`. */
function jsonResponse(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    finishReason: "stop" as const,
    usage,
    warnings: [],
  };
}

/** A `doGenerate` response that asks to call `toolName` with `args`. */
function toolCallResponse(toolName: string, args: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call_1",
        toolName,
        input: JSON.stringify(args),
      },
    ],
    finishReason: "tool-calls" as const,
    usage,
    warnings: [],
  };
}

function fakeGraphDeps(overrides: Partial<GraphToolDeps> = {}): GraphToolDeps {
  return {
    searchGraph: async () => [],
    getProblemContext: async () => ({}),
    expandNeighborhood: async () => ({ nodes: [], edges: [] }),
    findSolvedNeighbors: async () => [],
    getClusterSummary: async () => ({ summary: "" }),
    ...overrides,
  };
}

describe("createAiReasoner with MockLanguageModelV2", () => {
  it("parses a structured classification from the model", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () =>
        jsonResponse({
          classifications: [
            { candidateId: "p_a", kind: "identical", confidence: 0.9, rationale: "same" },
          ],
        }),
    });

    const reasoner = createAiReasoner(model);
    const out = await reasoner.classify({
      problem,
      candidates: [{ id: "p_a", title: "A", body: "a", similarity: 0.95 }],
    });

    expect(out).toEqual([
      { candidateId: "p_a", kind: "identical", confidence: 0.9, rationale: "same" },
    ]);
  });

  it("runs the graph-tool loop during synthesis, then emits the structured solution", async () => {
    const searchGraph = mock(async () => [
      { id: "p_a", title: "A", similarity: 0.9, linkKinds: ["identical"], hasAcceptedSolution: true },
    ]);

    // Step 1: the model calls searchGraph. Step 2: it emits the final solution.
    // (Function form with an explicit counter — the array form of
    // MockLanguageModelV2 indexes by call count *after* push, skipping index 0.)
    const responses = [
      toolCallResponse("searchGraph", { query: "login failures", k: 5 }),
      jsonResponse({ body: "Reset the session store", origin: "reused", reusedSolutionIds: ["s_a"] }),
    ];
    let call = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => responses[call++]!,
    });

    const tools = createGraphTools(fakeGraphDeps({ searchGraph }));
    const reasoner = createAiReasoner(model, { tools });

    const out = await reasoner.synthesize({ problem, relatedSolutions: [] });

    expect(searchGraph).toHaveBeenCalledTimes(1); // the tool loop actually executed
    expect(out).toEqual({
      body: "Reset the session store",
      origin: "reused",
      reusedSolutionIds: ["s_a"],
    });
    expect(model.doGenerateCalls.length).toBe(2); // tool call + final structured output
  });
});
