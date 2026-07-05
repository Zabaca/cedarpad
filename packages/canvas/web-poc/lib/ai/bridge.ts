import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLASSIFY_SYSTEM,
  ClassificationOutput,
  DRAFT_SYSTEM,
  DraftOutput,
  SYNTH_SYSTEM,
  SynthesisOutput,
} from "./reasoner.js";
import type { Reasoner } from "./types.js";

/**
 * Manual / human-in-the-loop reasoner. Instead of calling a hosted LLM, every
 * `classify` / `synthesize` / `draftProblem` call is serialized to a file and the
 * pipeline blocks until a matching answer file appears — letting an operator (or
 * Claude Code) act as the "internal LLM agent" with no API key.
 *
 * This is a dev/node-only port (it touches the filesystem). It is selected in
 * `apps/api/src/agent.ts` only when `AI_BRIDGE_DIR` is set, which never happens on
 * Cloudflare Workers, so the `node:fs` import is never exercised there.
 *
 * Directory layout under `dir`:
 *   pending/<id>.json    request written by the pipeline, awaiting an answer
 *   answered/<id>.json   answer written by the operator (the raw structured value)
 *   archive/<id>.*       completed request+answer pair, kept for audit
 */
export interface BridgeReasonerOptions {
  dir: string;
  /** How long a single call waits for its answer before giving up. */
  timeoutMs?: number;
  /** Poll interval while waiting for the answer file. */
  pollMs?: number;
  /** Label recorded on the agent run / surfaced to the operator. */
  providerModel?: string;
}

type Method = "classify" | "synthesize" | "draftProblem";

interface BridgeRequest {
  id: string;
  createdAt: number;
  method: Method;
  providerModel: string;
  /** The system prompt the real reasoner would send for this call. */
  system: string;
  /** Method-specific input the model reasons over. */
  input: unknown;
  /** Terse description of the JSON the answer file must contain. */
  responseSchema: string;
  /** A concrete, fill-in-the-blanks example of a valid answer. */
  responseExample: unknown;
  instructions: string;
}

const SCHEMA_HINT: Record<Method, string> = {
  classify:
    '{ "classifications": [ { "candidateId": string, "kind": "identical"|"partial"|"related"|"unrelated", "confidence": 0..1, "rationale": string } ] } — one entry per candidate, same order.',
  synthesize:
    '{ "body": string, "origin": "reused"|"synthesized"|"research", "reusedSolutionIds": string[] }',
  draftProblem:
    '{ "title": string, "body": string, "impact": string, "urgency": "low"|"medium"|"high"|"critical", "solutionDirection": string }',
};

const EXAMPLE: Record<Method, unknown> = {
  classify: {
    classifications: [
      { candidateId: "p_123", kind: "related", confidence: 0.6, rationale: "same area, distinct problem" },
    ],
  },
  synthesize: {
    body: "Concrete, actionable solution…",
    origin: "synthesized",
    reusedSolutionIds: [],
  },
  draftProblem: {
    title: "Short problem title",
    body: "What the observations collectively reveal…",
    impact: "Who/what it costs",
    urgency: "medium",
    solutionDirection: "How a solution should be structured",
  },
};

const SYSTEM: Record<Method, string> = {
  classify: CLASSIFY_SYSTEM,
  synthesize: SYNTH_SYSTEM,
  draftProblem: DRAFT_SYSTEM,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBridgeReasoner(opts: BridgeReasonerOptions): Reasoner {
  const { dir } = opts;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const pollMs = opts.pollMs ?? 500;
  const providerModel = opts.providerModel ?? "bridge:manual";

  const pendingDir = join(dir, "pending");
  const answeredDir = join(dir, "answered");
  const archiveDir = join(dir, "archive");

  let seq = 0;
  const nextId = (method: Method) =>
    `${Date.now().toString(36)}-${(seq++).toString(36)}-${method}`;

  /** Write a request, then block until its answer file shows up; return the parsed JSON. */
  async function exchange(method: Method, input: unknown): Promise<unknown> {
    await Promise.all([
      mkdir(pendingDir, { recursive: true }),
      mkdir(answeredDir, { recursive: true }),
      mkdir(archiveDir, { recursive: true }),
    ]);

    const id = nextId(method);
    const request: BridgeRequest = {
      id,
      createdAt: Date.now(),
      method,
      providerModel,
      system: SYSTEM[method],
      input,
      responseSchema: SCHEMA_HINT[method],
      responseExample: EXAMPLE[method],
      instructions: `Reason as the internal LLM, then write your answer as JSON to "${join(
        answeredDir,
        `${id}.json`,
      )}". It must match responseSchema. The bare value or { "result": value } are both accepted.`,
    };

    const requestPath = join(pendingDir, `${id}.json`);
    const answerPath = join(answeredDir, `${id}.json`);
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const raw = await readFile(answerPath, "utf8").catch(() => null);
      if (raw != null) {
        const parsed = JSON.parse(raw);
        const value =
          parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
        // Archive the completed exchange for audit, then return.
        await Promise.all([
          rename(requestPath, join(archiveDir, `${id}.request.json`)).catch(() => {}),
          rename(answerPath, join(archiveDir, `${id}.answer.json`)).catch(() => {}),
        ]);
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `AI bridge timed out after ${timeoutMs}ms waiting for ${requestPath}. ` +
            `Answer it (write ${answerPath}) or unset AI_BRIDGE_DIR.`,
        );
      }
      await sleep(pollMs);
    }
  }

  return {
    async classify({ problem, candidates }) {
      const value = await exchange("classify", { problem, candidates });
      return ClassificationOutput.parse(value).classifications;
    },
    async synthesize({ problem, relatedSolutions, graphContext }) {
      const value = await exchange("synthesize", { problem, relatedSolutions, graphContext });
      return SynthesisOutput.parse(value);
    },
    async draftProblem({ observations, hint }) {
      const value = await exchange("draftProblem", { observations, hint });
      return DraftOutput.parse(value);
    },
  };
}

/** List of pending bridge request files, oldest first (helper for the CLI). */
export async function listPendingRequests(dir: string): Promise<BridgeRequest[]> {
  const pendingDir = join(dir, "pending");
  const names = await readdir(pendingDir).catch(() => [] as string[]);
  const requests = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map((n) => readFile(join(pendingDir, n), "utf8").then((r) => JSON.parse(r) as BridgeRequest)),
  );
  return requests.sort((a, b) => a.createdAt - b.createdAt);
}
