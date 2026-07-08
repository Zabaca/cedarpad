import type { Env } from './index.ts';

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

// #63 STUB run: a trivial liveness step that proves the wake→run→sleep path is real and
// testable end-to-end without the workflow. The actual Explore→gate→ask_human→PR
// workflow is #66; the git/worktree machinery is #64. Keep this a no-op-ish liveness
// check — do NOT grow it into the workflow harness here.
export async function runDevAgent(sandbox: DevAgentRunner): Promise<void> {
  const res = await sandbox.exec('echo dev-agent-alive');
  console.log(`[dev-agent] liveness exit=${res.exitCode} out=${res.stdout.trim()}`);
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
  console.log(`[dev-agent] scheduled run — cron=${event.cron} at=${new Date(event.scheduledTime).toISOString()}`);
  const sandbox = seam.sandbox(env);
  try {
    await seam.run(sandbox);
  } catch (e: unknown) {
    console.error(`[dev-agent] run failed: ${String((e as Error)?.stack ?? e)}`);
    throw e;
  }
}
