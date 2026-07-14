import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { jobRunStamps } from "../schema.js";

/**
 * Job run stamps (#196, ADR-0015): the cron evaluator's per-(workspace, repo, job)
 * debounce. Bookkeeping only — the job list is discovered off the repo every tick.
 */

export async function getJobRunStamp(
  db: Database,
  key: { workspaceId: string; repo: string; job: string },
): Promise<Date | null> {
  const [row] = await db
    .select({ lastRunAt: jobRunStamps.lastRunAt })
    .from(jobRunStamps)
    .where(
      and(
        eq(jobRunStamps.workspaceId, key.workspaceId),
        eq(jobRunStamps.repo, key.repo),
        eq(jobRunStamps.job, key.job),
      ),
    )
    .limit(1);
  return row?.lastRunAt ?? null;
}

export async function stampJobRun(
  db: Database,
  key: { workspaceId: string; repo: string; job: string; nowMs: number },
): Promise<void> {
  await db
    .insert(jobRunStamps)
    .values({ workspaceId: key.workspaceId, repo: key.repo, job: key.job, lastRunAt: new Date(key.nowMs) })
    .onConflictDoUpdate({
      target: [jobRunStamps.workspaceId, jobRunStamps.repo, jobRunStamps.job],
      set: { lastRunAt: new Date(key.nowMs) },
    });
}
