import type { Env } from './index.ts';
import { CANVAS_CONTAINER_CWD } from './container-env.ts';

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
export interface DevAgentRunner {
  exec(command: string): Promise<{ exitCode: number; stdout: string }>;
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

// #66 run: kick ONE scheduled workflow inside the container. The edge wakes the dev-agent
// sandbox (dispatchDevAgentRun) then calls this; a non-zero exit is surfaced (thrown) so the
// dispatcher rethrows it rather than silently swallowing a failed run.
export async function runDevAgent(sandbox: DevAgentRunner): Promise<void> {
  const res = await sandbox.exec(DEV_AGENT_WORKFLOW_CMD);
  console.log(`[dev-agent] workflow exit=${res.exitCode} out=${res.stdout.trim()}`);
  if (res.exitCode !== 0) throw new Error(`dev-agent workflow exited ${res.exitCode}: ${res.stdout.trim()}`);
}

// The dispatch seam: which sandbox to wake, and what run to kick. The default seam
// (wiring the real `devAgentSandbox` + `runDevAgent`) is applied at the call site in
// index.ts so this pure module stays import-clean; tests pass a fake.
export interface DevAgentSeam {
  sandbox: (env: Env) => DevAgentRunner;
  run: (sandbox: DevAgentRunner) => Promise<void>;
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
  const sandbox = seam.sandbox(env);
  try {
    await seam.run(sandbox);
  } catch (e: unknown) {
    console.error(`[dev-agent] run failed: ${String((e as Error)?.stack ?? e)}`);
    throw e;
  }
}
