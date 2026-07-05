import { describe, expect, it } from "bun:test";
import { createHashEmbedder } from "./embedder.js";
import {
  type PipelineEntity,
  type PipelinePorts,
  type SavedLink,
  runAgentPipeline,
} from "./pipeline.js";
import type {
  Candidate,
  Classification,
  GraphContextItem,
  ProblemDraft,
  Reasoner,
  ReuseSolution,
  SynthesisResult,
} from "./types.js";

type SavedSolution = { body: string; origin: string; targetKind: string; targetId: string };

/** In-memory ports recording everything the pipeline does. */
function makeFakePorts(opts: {
  problem: PipelineEntity;
  candidates: Candidate[];
  solutions?: ReuseSolution[];
  graphContext?: GraphContextItem[];
}): PipelinePorts & {
  links: SavedLink[];
  savedSolutions: SavedSolution[];
  events: { type: string; id: string }[];
  runs: { id: string; status?: string }[];
  embeddingSet: { problemId: string; model: string } | null;
} {
  const links: SavedLink[] = [];
  const savedSolutions: SavedSolution[] = [];
  const events: { type: string; id: string }[] = [];
  const runs: { id: string; status?: string }[] = [];
  let embeddingSet: { problemId: string; model: string } | null = null;
  const notImplemented = async () => {
    throw new Error("not used in this test");
  };

  return {
    links,
    savedSolutions,
    events,
    runs,
    get embeddingSet() {
      return embeddingSet;
    },
    async getProblem(id) {
      return id === opts.problem.id ? opts.problem : null;
    },
    async setProblemEmbedding(problemId, _embedding, model) {
      embeddingSet = { problemId, model };
    },
    async findSimilarProblems() {
      return opts.candidates;
    },
    async getSolutionsForProblems(ids) {
      return (opts.solutions ?? []).filter((s) => ids.includes(s.problemId));
    },
    async getNeighborhoodContext(ids, maxItems) {
      return (opts.graphContext ?? []).filter((g) => ids.includes(g.problemId)).slice(0, maxItems);
    },
    async saveProblemLink(link) {
      links.push(link);
    },
    async saveSolution(input) {
      savedSolutions.push(input);
      return `sol_${savedSolutions.length}`;
    },
    // Observation-intake ports (unused by these problem-intake tests).
    getObservation: notImplemented as PipelinePorts["getObservation"],
    setObservationEmbedding: notImplemented as PipelinePorts["setObservationEmbedding"],
    findSimilarObservations: notImplemented as PipelinePorts["findSimilarObservations"],
    saveObservationLink: notImplemented as PipelinePorts["saveObservationLink"],
    getObservationsByIds: notImplemented as PipelinePorts["getObservationsByIds"],
    createProblemFromDraft: notImplemented as PipelinePorts["createProblemFromDraft"],
    linkObservationsToProblem: notImplemented as PipelinePorts["linkObservationsToProblem"],
    async startRun() {
      const id = `run_${runs.length + 1}`;
      runs.push({ id });
      return id;
    },
    async finishRun(runId, result) {
      const run = runs.find((r) => r.id === runId);
      if (run) run.status = result.status;
    },
    async publish(event) {
      events.push({ type: event.type, id: event.target.id });
    },
  };
}

const draft: ProblemDraft = {
  title: "t",
  body: "b",
  impact: "i",
  urgency: "medium",
  solutionDirection: "s",
};

function fakeReasoner(classifications: Classification[], synthesis: SynthesisResult): Reasoner {
  return {
    async classify() {
      return classifications;
    },
    async synthesize() {
      return synthesis;
    },
    async draftProblem() {
      return draft;
    },
  };
}

const baseProblem: PipelineEntity = {
  id: "p_new",
  workspaceId: "ws1",
  title: "Login fails intermittently",
  body: "Users sometimes cannot log in",
};

describe("runAgentPipeline", () => {
  const embedder = createHashEmbedder(64);

  it("persists links for non-unrelated candidates and skips unrelated", async () => {
    const candidates: Candidate[] = [
      { id: "p_a", title: "A", body: "a", similarity: 0.95 },
      { id: "p_b", title: "B", body: "b", similarity: 0.81 },
      { id: "p_c", title: "C", body: "c", similarity: 0.4 },
    ];
    const ports = makeFakePorts({ problem: baseProblem, candidates });
    const reasoner = fakeReasoner(
      [
        { candidateId: "p_a", kind: "identical", confidence: 0.9, rationale: "same" },
        { candidateId: "p_b", kind: "partial", confidence: 0.7, rationale: "overlap" },
        { candidateId: "p_c", kind: "unrelated", confidence: 0.8, rationale: "false positive" },
      ],
      { body: "Reset the session store", origin: "reused", reusedSolutionIds: ["sol_x"] },
    );

    const result = await runAgentPipeline(
      { ports, reasoner, embedder, config: { topK: 8, providerModel: "test-model" } },
      "p_new",
    );

    expect(ports.links.map((l) => l.toId)).toEqual(["p_a", "p_b"]);
    expect(ports.links[0]!.kind).toBe("identical");
    expect(ports.links[0]!.similarity).toBe(0.95);
    expect(result.solutionId).toBe("sol_1");
    expect(ports.embeddingSet).toEqual({ problemId: "p_new", model: "local-hash-v1" });
  });

  it("reuses solutions only from identical/partial linked problems", async () => {
    const candidates: Candidate[] = [
      { id: "p_a", title: "A", body: "a", similarity: 0.95 }, // identical -> reusable
      { id: "p_r", title: "R", body: "r", similarity: 0.6 }, // related -> NOT reusable
    ];
    let receivedReuseIds: string[] = [];
    const reasoner: Reasoner = {
      async classify() {
        return [
          { candidateId: "p_a", kind: "identical", confidence: 0.9, rationale: "same" },
          { candidateId: "p_r", kind: "related", confidence: 0.6, rationale: "same area" },
        ];
      },
      async synthesize({ relatedSolutions }) {
        receivedReuseIds = relatedSolutions.map((s) => s.problemId);
        return { body: "do x", origin: "synthesized", reusedSolutionIds: [] };
      },
      async draftProblem() {
        return draft;
      },
    };
    const ports = makeFakePorts({
      problem: baseProblem,
      candidates,
      solutions: [
        { id: "s1", problemId: "p_a", body: "fix a" },
        { id: "s2", problemId: "p_r", body: "fix r" },
      ],
    });

    await runAgentPipeline(
      { ports, reasoner, embedder, config: { topK: 8, providerModel: "test-model" } },
      "p_new",
    );

    expect(receivedReuseIds).toEqual(["p_a"]); // only the identical one
  });

  it("feeds the linked problems' graph context into synthesis", async () => {
    const candidates: Candidate[] = [{ id: "p_a", title: "A", body: "a", similarity: 0.95 }];
    const graphContext: GraphContextItem[] = [
      {
        problemId: "p_a",
        title: "A",
        depth: 1,
        solutions: [{ body: "fix a", status: "accepted", origin: "synthesized" }],
      },
    ];
    let received: GraphContextItem[] | undefined;
    const reasoner: Reasoner = {
      async classify() {
        return [{ candidateId: "p_a", kind: "identical", confidence: 0.9, rationale: "same" }];
      },
      async synthesize({ graphContext: gc }) {
        received = gc;
        return { body: "do x", origin: "reused", reusedSolutionIds: [] };
      },
      async draftProblem() {
        return draft;
      },
    };
    const ports = makeFakePorts({ problem: baseProblem, candidates, graphContext });

    await runAgentPipeline(
      { ports, reasoner, embedder, config: { topK: 8, providerModel: "test-model" } },
      "p_new",
    );

    expect(received).toEqual(graphContext);
  });

  it("publishes a processed event and completes the run on success", async () => {
    const ports = makeFakePorts({ problem: baseProblem, candidates: [] });
    const reasoner = fakeReasoner([], {
      body: "fresh solution",
      origin: "research",
      reusedSolutionIds: [],
    });

    await runAgentPipeline(
      { ports, reasoner, embedder, config: { topK: 8, providerModel: "test-model" } },
      "p_new",
    );

    expect(ports.events).toEqual([{ type: "problem.processed", id: "p_new" }]);
    expect(ports.runs[0]!.status).toBe("completed");
    expect(ports.savedSolutions[0]!.origin).toBe("research");
  });

  it("marks the run failed and rethrows when a step throws", async () => {
    const ports = makeFakePorts({ problem: baseProblem, candidates: [] });
    const reasoner: Reasoner = {
      async classify() {
        throw new Error("model exploded");
      },
      async synthesize() {
        return { body: "", origin: "synthesized", reusedSolutionIds: [] };
      },
      async draftProblem() {
        return draft;
      },
    };

    await expect(
      runAgentPipeline(
        { ports, reasoner, embedder, config: { topK: 8, providerModel: "test-model" } },
        "p_new",
      ),
    ).rejects.toThrow("model exploded");
    expect(ports.runs[0]!.status).toBe("failed");
    expect(ports.events[0]!.type).toBe("problem.failed");
  });
});

describe("createHashEmbedder", () => {
  it("is deterministic and normalized", async () => {
    const e = createHashEmbedder(128);
    const a = await e.embed("hello world");
    const b = await e.embed("hello world");
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("produces closer vectors for overlapping text (cosine)", async () => {
    const e = createHashEmbedder(256);
    const base = await e.embed("database connection pool exhausted");
    const near = await e.embed("connection pool exhausted in database");
    const far = await e.embed("the cat sat quietly on a warm mat");
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(cos(base, near)).toBeGreaterThan(cos(base, far));
  });
});
