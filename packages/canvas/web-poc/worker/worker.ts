import {
  runAgentPipeline,
  runObservationPipeline,
  synthesizeProblemFromObservations,
} from "../lib/ai/index.js";
import { type Database, claimNextAgentJob, completeAgentJob, schema } from "../lib/db/index.js";
import { createPipelineDeps } from "./agent.js";

type AgentJob = schema.AgentJob;
import type { Bindings } from "./context.js";
import { publish, workspaceChannel } from "./realtime.js";

/**
 * Run one job's work. Returns a `result` to record on the job (e.g. the new
 * problem id from synthesis). Throws on failure — the caller marks it failed.
 */
async function runJob(
  db: Database,
  env: Bindings,
  job: AgentJob,
): Promise<Record<string, unknown> | undefined> {
  const deps = createPipelineDeps(db, env);
  const p = job.payload;

  switch (job.kind) {
    case "problem_intake":
      await runAgentPipeline(deps, p.targetId as string);
      return undefined;
    case "observation_intake":
      await runObservationPipeline(deps, p.targetId as string);
      return undefined;
    case "synthesis": {
      const result = await synthesizeProblemFromObservations(deps, {
        workspaceId: p.workspaceId as string,
        observationIds: p.observationIds as string[],
        createdBy: (p.createdBy as string | null) ?? null,
        hint: p.hint as Record<string, unknown> | undefined,
        projectTags: p.projectTags as string[] | undefined,
      });
      // The new problem didn't exist at request time; tell subscribers it's here.
      await publish(env, workspaceChannel(p.workspaceId as string), {
        type: "problem.synthesized",
        payload: { id: result.problemId },
      });
      return { problemId: result.problemId };
    }
  }
}

/** Claim and process the next queued job. Returns the job, or null if none. */
export async function processNextJob(db: Database, env: Bindings): Promise<AgentJob | null> {
  const job = await claimNextAgentJob(db);
  if (!job) return null;
  try {
    const result = await runJob(db, env, job);
    await completeAgentJob(db, job.id, { status: "done", result });
  } catch (err) {
    await completeAgentJob(db, job.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return job;
}

/** Drain queued jobs until the queue is empty (or `max` processed). Returns the count. */
export async function drainAgentJobs(
  db: Database,
  env: Bindings,
  opts: { max?: number } = {},
): Promise<number> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  let n = 0;
  while (n < max) {
    const job = await processNextJob(db, env);
    if (!job) break;
    n++;
  }
  return n;
}
