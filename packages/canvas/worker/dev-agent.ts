import type { Env } from './index.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { CANVAS_CONTAINER_CWD, containerEnv } from './container-env.ts';

// The dev-agent runner (ADR-0007, PRD #51 slice #63) — PURE core. A SEPARATE sandbox
// instance of the SAME product image, on its OWN sleep schedule, driving continuous dev
// workflows off the product runtime so it never fights a workspace container's sleep
// timer. Kept free of any `@cloudflare/sandbox` / `cloudflare:workers` import so it's
// unit-testable off the edge runtime — the stub that wakes the real container
// (`devAgentSandbox`) lives in `sandbox-runtime.ts` alongside the other sandbox plumbing.

// Distinctly keyed so it can NEVER collide with a workspace container. Product ids are
// `'canvas'` (legacy/default) and `'workspace-<id>'` (derived) — see sandbox-resolver.ts
// — so `'dev-agent'` is disjoint from every workspace id by construction.
export const DEV_AGENT_SANDBOX_ID = 'dev-agent';

// Its OWN sleep timer, independent of the product's 5m. Short on purpose: the dev-agent
// wakes on a cron, does one run, then should sleep promptly — it serves no interactive
// traffic, so there is no idle-tab window to keep warm.
export const DEV_AGENT_SLEEP_AFTER = '2m';

// Minimal seam over the sandbox stub so `runDevAgent` (and the scheduled dispatch) is
// testable with a fake — the real `devAgentSandbox(env)` stub satisfies this structurally.
// `setEnvVars` injects the batch run's env (below) BEFORE the exec; without it the exec
// inherits only the Dockerfile ENV and dev-agent-run.ts throws (no DEV_AGENT_USER_ID/OAuth/Turso).
export interface DevAgentRunner {
  setEnvVars(env: Record<string, string>): Promise<void>;
  exec(command: string): Promise<{ exitCode: number; stdout: string }>;
}

// The dev-agent container's coords for the batch env (its own R2 prefix + workspace id). Mirrors
// the interactive path's coordsForWorkspace('dev-agent') without importing it (that pulls the
// @cloudflare/sandbox layer, which this pure module must not).
const DEV_AGENT_COORDS: SandboxCoords = {
  sandboxId: DEV_AGENT_SANDBOX_ID,
  r2Prefix: 'workspaces/dev-agent/',
  canvasWorkspace: 'dev-agent',
};

// The env the batch exec needs. containerEnv supplies OAuth/Turso/R2/CANVAS_WORKSPACE(=dev-agent)/
// CANVAS_USER; DEV_AGENT_USER_ID (the owner the promoted Conversation is filed under — the
// single-tenant CANVAS_USER) is the one var dev-agent-run.ts reads that containerEnv doesn't set.
// The GitHub App token is NOT here: the batch (Explore → ask_human) opens no PR — that's the
// interactive open_pr path (#96), which mints its own on the interactive boot.
export function devAgentBatchEnv(env: Env): Record<string, string> {
  return { ...containerEnv(env, DEV_AGENT_COORDS), DEV_AGENT_USER_ID: env.CANVAS_USER ?? '' };
}

// Coexistence, not replacement (ADR-0009 Tier 2 / #125). The dev-agent sandbox has TWO boot
// paths on the SAME image, and they COEXIST as separate processes on the one instance:
//   • scheduled batch — the cron `exec`s this workflow command (a transient one-shot run that
//     Explores, gates, promotes a Conversation, then lets the instance idle-sleep on its 2m timer);
//   • interactive bridge — an INTERACTIVE chat proxied to the dev-agent (edge chat proxy →
//     coordsForWorkspace('dev-agent') → serveWorkspace) cold-starts the SAME product interactive
//     stack every workspace container runs (`scripts/container-start.ts` → vite + bridge), booted
//     LAZILY on the first interactive request — never eagerly.
// We deliberately do NOT "always boot the interactive stack": off-hours the batch run stays cheap
// (wake, run, sleep), and the two are synergistic — the explore session the batch writes to
// ~/.claude/projects is exactly what the interactive bridge later restores + resumes as a chat
// turn. Both processes share the container's process.cwd() (the canvas package dir), so a resumed
// dev-agent session's JSONL is restored to the path the bridge's `query({ resume })` reads.
//
// The command the container runs for one scheduled workflow. The Explore→gate→ask_human
// harness (#66) is CONTAINER-side (it needs the SDK/Turso/git) — the edge only wakes the
// sandbox and execs this entrypoint (`server/dev-agent-run.ts`), which assembles the real
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

// The shared run core (cron AND manual trigger): wake the dev-agent sandbox, inject env, exec the
// workflow. NO DEV_AGENT_ENABLED gate — that kill-switch is only about the daily CRON auto-firing
// (see dispatchDevAgentRun). A manual trigger (Jobs UI / API) is an explicit user action, so it
// runs regardless of the flag. A run that throws is surfaced (logged + rethrown), never swallowed,
// and touches ONLY the dev-agent instance.
export async function runDevAgentNow(env: Env, seam: DevAgentSeam): Promise<void> {
  const sandbox = seam.sandbox(env);
  try {
    await seam.run(sandbox, env);
  } catch (e: unknown) {
    console.error(`[dev-agent] run failed: ${String((e as Error)?.stack ?? e)}`);
    throw e;
  }
}

// The cron handler's core, extracted so it's unit-testable without a live cron or
// container. Wakes the dev-agent sandbox and kicks one run; it then idle-sleeps on its
// own `DEV_AGENT_SLEEP_AFTER`. A run that throws is surfaced (logged + rethrown) — never
// silently swallowed — and touches ONLY the dev-agent instance, never a workspace one.
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
