import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createBridgeReasoner, listPendingRequests } from "./bridge.js";
import type { Candidate, EntityInput } from "./types.js";

const problem: EntityInput = { id: "p_new", title: "Login fails", body: "intermittent" };
const candidates: Candidate[] = [{ id: "p_1", title: "Auth flaky", body: "x", similarity: 0.85 }];

async function freshDir() {
  return mkdtemp(join(tmpdir(), "ai-bridge-"));
}

/** Wait for a pending request to appear, then write the given answer for it. */
async function answerWhenAsked(dir: string, answer: unknown) {
  for (let i = 0; i < 200; i++) {
    const pending = await listPendingRequests(dir);
    if (pending[0]) {
      await writeFile(
        join(dir, "answered", `${pending[0].id}.json`),
        JSON.stringify(answer),
        "utf8",
      );
      return pending[0];
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no pending request appeared");
}

describe("createBridgeReasoner", () => {
  it("serializes a classify request and returns the operator's answer", async () => {
    const dir = await freshDir();
    const reasoner = createBridgeReasoner({ dir, pollMs: 10 });

    const [result, req] = await Promise.all([
      reasoner.classify({ problem, candidates }),
      answerWhenAsked(dir, {
        classifications: [
          { candidateId: "p_1", kind: "partial", confidence: 0.7, rationale: "shares root cause" },
        ],
      }),
    ]);

    expect(req.method).toBe("classify");
    expect(result).toEqual([
      { candidateId: "p_1", kind: "partial", confidence: 0.7, rationale: "shares root cause" },
    ]);
  });

  it("accepts a bare value or a { result } envelope and archives the exchange", async () => {
    const dir = await freshDir();
    const reasoner = createBridgeReasoner({ dir, pollMs: 10 });

    const [synthesis] = await Promise.all([
      reasoner.synthesize({ problem, relatedSolutions: [] }),
      answerWhenAsked(dir, {
        result: { body: "do X", origin: "synthesized", reusedSolutionIds: [] },
      }),
    ]);

    expect(synthesis).toEqual({ body: "do X", origin: "synthesized", reusedSolutionIds: [] });
    // Request + answer moved to archive/, pending/ drained.
    expect(await listPendingRequests(dir)).toHaveLength(0);
    const archived = await readdir(join(dir, "archive"));
    expect(archived.some((f) => f.endsWith(".request.json"))).toBe(true);
    expect(archived.some((f) => f.endsWith(".answer.json"))).toBe(true);
  });

  it("rejects an answer that violates the schema", async () => {
    const dir = await freshDir();
    const reasoner = createBridgeReasoner({ dir, pollMs: 10 });

    await expect(
      Promise.all([
        reasoner.draftProblem({ observations: [problem] }),
        answerWhenAsked(dir, { title: "t" /* missing required fields */ }),
      ]),
    ).rejects.toThrow();
  });

  it("times out with an actionable error when no answer arrives", async () => {
    const dir = await freshDir();
    const reasoner = createBridgeReasoner({ dir, pollMs: 5, timeoutMs: 30 });
    await expect(reasoner.classify({ problem, candidates })).rejects.toThrow(/timed out/);
  });

  it("writes a request file an operator can read while waiting", async () => {
    const dir = await freshDir();
    const reasoner = createBridgeReasoner({ dir, pollMs: 10 });
    const call = reasoner.draftProblem({ observations: [problem], hint: { urgency: "high" } });

    const req = await answerWhenAsked(dir, {
      title: "T",
      body: "B",
      impact: "I",
      urgency: "high",
      solutionDirection: "S",
    });
    await call;

    const archived = join(dir, "archive", `${req.id}.request.json`);
    const onDisk = JSON.parse(await readFile(archived, "utf8"));
    expect(onDisk.input.hint).toEqual({ urgency: "high" });
    expect(onDisk.responseSchema).toContain("urgency");
  });
});
