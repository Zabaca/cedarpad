import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE, resolve } from './sandbox-resolver.ts';
import { CANVAS_CONTAINER_CWD, containerEnv } from './container-env.ts';
import { singleFlight } from './single-flight.ts';

// The dev-agent runner (ADR-0007 PRD #51, re-shaped by ADR-0010) — PURE core. The dev-agent
// is a ROLE the warm default container plays, not a separate container: a batch run wakes
// THAT container and execs the workflow on it, and the promoted Conversation (tagged
// 'dev-agent') resumes there like any product chat. Kept free of any `@cloudflare/sandbox` /
// `cloudflare:workers` import so it's unit-testable off the edge runtime.

// The LOGICAL dev-agent tag (=== DEV_AGENT_WORKSPACE_ID in server/dev-agent-workflow.ts):
// the Conversation.workspaceId a dev-agent run files under. NOT a container key anymore
// (ADR-0010) — dev-agent Conversations resume on the warm default container. Product
// workspace ids are `'default'` and registry `cs_…` ids (derived containers are
// `workspace-<id>`), so `'dev-agent'` stays disjoint from every product id by construction.
export const DEV_AGENT_SANDBOX_ID = 'dev-agent';

// The retired separate instance's sleep timer — still consumed by `devAgentSandbox`
// (sandbox-runtime.ts) until that stub is deleted with the rest of the separate-container
// scaffolding (ADR-0010 cleanup slice).
export const DEV_AGENT_SLEEP_AFTER = '2m';

// Minimal seam over the sandbox stub so `runDevAgent` (and the scheduled dispatch) is
// testable with a fake — the real `devAgentSandbox(env)` stub satisfies this structurally.
// `setEnvVars` injects the batch run's env (below) BEFORE the exec; without it the exec
// inherits only the Dockerfile ENV and dev-agent-run.ts throws (no DEV_AGENT_USER_ID/OAuth/Turso).
export interface DevAgentRunner {
  setEnvVars(env: Record<string, string>): Promise<void>;
  exec(command: string): Promise<{ exitCode: number; stdout: string }>;
}

// The env the batch exec needs. The batch runs ON the warm default container (ADR-0010), so
// containerEnv is built from the DEFAULT workspace coords — CANVAS_WORKSPACE='default', matching
// the container it execs on — plus DEV_AGENT_USER_ID (the owner the promoted Conversation is
// filed under — the single-tenant CANVAS_USER), the one var dev-agent-run.ts reads that
// containerEnv doesn't set. The GitHub App token is NOT here: the batch (Explore → ask_human)
// opens no PR — that's the interactive open_pr path, token-armed per send (ADR-0010).
export function devAgentBatchEnv(env: Env): Record<string, string> {
  return { ...containerEnv(env, resolve(DEFAULT_WORKSPACE)), DEV_AGENT_USER_ID: env.CANVAS_USER ?? '' };
}

// Coexistence on the ONE warm container (ADR-0010). The batch exec and the interactive stack
// are separate processes on the SAME default container:
//   • scheduled/manual batch — `exec`s this workflow command (a transient one-shot run that
//     Explores, gates, promotes a Conversation) alongside whatever the container is serving;
//   • interactive resume — the promoted dev-agent Conversation resumes through the edge chat
//     proxy on the same container's bridge, exactly like any product chat.
// The two are synergistic: the explore session the batch writes to ~/.claude/projects is exactly
// what the bridge later restores + resumes as a chat turn. Both run under CANVAS_CONTAINER_CWD,
// so a resumed dev-agent session's JSONL sits at the path the bridge's `query({ resume })` reads.
//
// The command the container runs for one scheduled workflow. The Explore→gate→ask_human
// harness (#66) is CONTAINER-side (it needs the SDK/Turso/git) — the edge only wakes the
// container and execs this entrypoint (`server/dev-agent-run.ts`), which assembles the real
// seams and calls `runDevAgentWorkflow`. Kept as a string command so the edge worker never
// imports the container-only harness (bundle stays clean).
export const DEV_AGENT_WORKFLOW_CMD =
  `cd ${CANVAS_CONTAINER_CWD} && bun run server/dev-agent-run.ts`;

// #66 run: kick ONE workflow inside the container. Injects the batch env (so dev-agent-run.ts sees
// DEV_AGENT_USER_ID/OAuth/Turso) THEN execs. A non-zero exit is surfaced (thrown) so the caller
// rethrows it rather than silently swallowing a failed run.
export async function runDevAgent(sandbox: DevAgentRunner, env: Env): Promise<void> {
  await sandbox.setEnvVars(devAgentBatchEnv(env));
  const res = await sandbox.exec(DEV_AGENT_WORKFLOW_CMD);
  console.log(`[dev-agent] workflow exit=${res.exitCode} out=${res.stdout.trim()}`);
  if (res.exitCode !== 0) throw new Error(`dev-agent workflow exited ${res.exitCode}: ${res.stdout.trim()}`);
}

// The dispatch seam: which sandbox to wake, and what run to kick. The default seam
// (wiring the real `devAgentSandbox` + `runDevAgent`) is applied at the call site in
// index.ts so this pure module stays import-clean; tests pass a fake.
export interface DevAgentSeam {
  sandbox: (env: Env) => DevAgentRunner;
  run: (sandbox: DevAgentRunner, env: Env) => Promise<void>;
}

// Single-flight for the batch run (ADR-0010): cron + repeated "Run now" clicks collapse onto
// ONE in-flight exec instead of piling up concurrent workflows on the shared container.
// Module-scoped like the cold-boot map (#138); cleared when the run settles.
const inflightRun = new Map<string, Promise<void>>();

// The shared run core (cron AND manual trigger): wake the warm default container, inject env,
// exec the workflow. NO DEV_AGENT_ENABLED gate — that kill-switch is only about the daily CRON
// auto-firing (see dispatchDevAgentRun). A manual trigger (Jobs UI / API) is an explicit user
// action, so it runs regardless of the flag. A run that throws is surfaced (logged + rethrown),
// never swallowed. Concurrent triggers await the SAME run (single-flight) — no pile-up.
export function runDevAgentNow(env: Env, seam: DevAgentSeam): Promise<void> {
  return singleFlight(inflightRun, 'dev-agent', async () => {
    const sandbox = seam.sandbox(env);
    try {
      await seam.run(sandbox, env);
    } catch (e: unknown) {
      console.error(`[dev-agent] run failed: ${String((e as Error)?.stack ?? e)}`);
      throw e;
    }
  });
}

// The cron handler's core, extracted so it's unit-testable without a live cron or
// container. Wakes the warm default container and kicks one run (ADR-0010). A run that
// throws is surfaced (logged + rethrown) — never silently swallowed.
export async function dispatchDevAgentRun(
  event: { cron: string; scheduledTime: number },
  env: Env,
  seam: DevAgentSeam,
): Promise<void> {
  // Kill-switch: the cron fires daily, but the workflow can't do anything useful until
  // repo-connection (the GitHub App, #96) is wired — a run would just fail to clone. So
  // gate the whole dispatch behind DEV_AGENT_ENABLED (default off) to avoid daily errors
  // + wasted dev-agent boots. Flip the var to "true" once repo-connection ships.
  if (env.DEV_AGENT_ENABLED !== 'true') {
    console.log('[dev-agent] scheduled run skipped — DEV_AGENT_ENABLED is not "true"');
    return;
  }
  console.log(`[dev-agent] scheduled run — cron=${event.cron} at=${new Date(event.scheduledTime).toISOString()}`);
  await runDevAgentNow(env, seam);
}
