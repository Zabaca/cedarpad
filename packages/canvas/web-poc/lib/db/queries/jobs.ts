import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type AgentJob, agentJobs } from "../schema.js";

type JobKind = AgentJob["kind"];

const newJobId = () => `job_${crypto.randomUUID()}`;

/** Add a job to the queue. Returns the new job id. */
export async function enqueueAgentJob(
  db: Database,
  input: {
    kind: JobKind;
    payload: Record<string, unknown>;
    workspaceId: string;
    /** Higher drains first. Seed from the target problem's priority; default 0. */
    priority?: number;
  },
): Promise<string> {
  const id = newJobId();
  await db.insert(agentJobs).values({
    id,
    kind: input.kind,
    payload: input.payload,
    workspaceId: input.workspaceId,
    priority: input.priority ?? 0,
  });
  return id;
}

/**
 * Claim the highest-priority queued job (oldest-first within a priority),
 * flipping it to `running`. Returns null when the queue is empty.
 * Single-consumer-safe via the `status = 'queued'` guard on the update;
 * production multi-consumer ordering is handled by the queue/Workflow.
 */
export async function claimNextAgentJob(db: Database): Promise<AgentJob | null> {
  const [job] = await db
    .select()
    .from(agentJobs)
    .where(eq(agentJobs.status, "queued"))
    .orderBy(desc(agentJobs.priority), asc(agentJobs.createdAt))
    .limit(1);
  if (!job) return null;

  await db
    .update(agentJobs)
    .set({ status: "running", claimedAt: new Date(), attempts: job.attempts + 1 })
    .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "queued")));

  return { ...job, status: "running", attempts: job.attempts + 1 };
}

/** Mark a claimed job done/failed, recording any result or error. */
export async function completeAgentJob(
  db: Database,
  id: string,
  outcome: { status: "done" | "failed"; result?: Record<string, unknown>; error?: string },
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      status: outcome.status,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(agentJobs.id, id));
}
