import { getSandbox } from '@cloudflare/sandbox';
import type { Env } from './index.ts';
import { containerEnv } from './container-env.ts';
import { DEV_AGENT_SANDBOX_ID, DEV_AGENT_SLEEP_AFTER } from './dev-agent.ts';
import { type SandboxCoords, decideWarm } from './sandbox-resolver.ts';

// The Sandbox resolver's runtime half: the wake/expose/proxy orchestration that used
// to be inline in the Worker's fetch handler keyed by the constant `'canvas'`. The
// proven warm-proxy-first / cold-start-on-miss path is preserved verbatim — only its
// input (the sandbox id) is parameterized via the resolved coordinates. The pure
// decision logic lives in `sandbox-resolver.ts`; this module owns everything that
// touches `@cloudflare/sandbox`.

const VITE_PORT = 4510;
const PREVIEW_TOKEN = 'canvasproxy';
// The image is the whole workspace at /app/agent-canvas (root context); the canvas
// package — and its scripts/bridge/vite, plus the in-tree web-poc at
// packages/canvas/web-poc — live under packages/canvas.
const START = 'bash -lc "cd /app/agent-canvas/packages/canvas && exec bun run scripts/container-start.ts"';

// keepAlive + sleepAfter persist in the DO's storage across deploys; if keepAlive is
// ever stuck `true`, the container NEVER auto-sleeps and sleepAfter is ignored entirely
// (per @cloudflare/sandbox). Passing them to getSandbox re-applies the config via
// configure() on every entry, forcing keepAlive OFF and re-asserting sleepAfter — cheap
// hygiene so a stray keepAlive can't silently pin the container forever.
const SLEEP_AFTER = '5m';

/** The DO stub for a resolved workspace's container. */
export const sandboxFor = (env: Env, sandboxId: string) =>
  getSandbox(env.Sandbox, sandboxId, { normalizeId: true, keepAlive: false, sleepAfter: SLEEP_AFTER });

// The dev-agent's own container stub (ADR-0007, #63): a distinctly-keyed instance of the
// same image on its OWN, shorter sleep schedule — separate from every `sandboxFor`
// workspace container so a scheduled run never pins or reaps a product container.
export const devAgentSandbox = (env: Env) =>
  getSandbox(env.Sandbox, DEV_AGENT_SANDBOX_ID, {
    normalizeId: true,
    keepAlive: false,
    sleepAfter: DEV_AGENT_SLEEP_AFTER,
  });

type SandboxStub = ReturnType<typeof getSandbox>;

// Start (or recover) the dev stack and wait for vite. Mirrors the spike's warm/
// stale handling: try the running process, else start fresh; on a cold boot give
// vite + bridge time to come up (node_modules is image-resident, so no install).
// Write the creds to .env in the container so bun auto-loads them for the bridge
// and every child. setEnvVars / ProcessOptions.envVars proved racy across recycles
// (the bridge intermittently came up with no R2 creds and silently used local-fs);
// a file bun reads at startup is deterministic. Only called before a FRESH start —
// never while the bridge runs, so `bun --watch` can't restart-loop on .env churn.
async function writeEnvFile(sandbox: SandboxStub, ev: Record<string, string>): Promise<void> {
  const body =
    Object.entries(ev)
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join('\n') + '\n';
  // Written into the canvas package (the bridge's cwd) so bun auto-loads it for the
  // bridge and every child — including web-poc's mounted app (Turso/auth secrets).
  await sandbox.writeFile('/app/agent-canvas/packages/canvas/.env', body).catch(() => {});
}

async function ensureStack(sandbox: SandboxStub, env: Env, coords: SandboxCoords): Promise<void> {
  const ev = containerEnv(env, coords);
  await sandbox.setEnvVars(ev).catch(() => {}); // kept as a secondary path
  const opts = { processId: 'canvas', envVars: ev } as const;
  let proc = await sandbox.getProcess('canvas').catch(() => null);
  if (!proc) {
    await writeEnvFile(sandbox, ev); // creds in place BEFORE the bridge starts
    proc = await sandbox.startProcess(START, opts).catch(() => null);
  }
  // Generous first wait: a cold vite boot (esp. the first pull of a new image)
  // can take tens of seconds; a short timeout would kill a healthy-but-slow boot
  // and restart it pointlessly. 40s was too short: on a heavy boot vite bound after
  // it, so the worker killProcess'd a healthy stack — orphaning the already-bound
  // bridge/extension, so the restart hit EADDRINUSE, exited code 0, and surfaced as
  // ProcessExitedBeforeReadyError (intermittent 502 / ~100s boots after an idle sleep).
  // Reproduced + fixed in the sleep spike: 120s lets a slow-but-healthy boot finish.
  const up = proc
    ? await proc.waitForPort(VITE_PORT, { timeout: 120000 }).then(() => true).catch(() => false)
    : false;
  if (up) return;
  await sandbox.killProcess('canvas').catch(() => {});
  await writeEnvFile(sandbox, ev);
  const fresh = await sandbox.startProcess(START, opts);
  await fresh.waitForPort(VITE_PORT, { timeout: 120000 });
}

// Forward a request into the container's vite dev server (which proxies /api -> the
// bridge) and stream the response back. The one round-trip that's actually needed.
function proxy(sandbox: SandboxStub, request: Request, sandboxId: string): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('x-sandbox-preview-proxy', '1');
  headers.set('x-sandbox-preview-port', String(VITE_PORT));
  headers.set('x-sandbox-preview-token', PREVIEW_TOKEN);
  headers.set('x-sandbox-preview-sandbox-id', sandboxId);
  return sandbox.fetch(new Request(request, { headers }));
}

// Warm-proxy-first / cold-start-on-miss orchestration for a resolved workspace.
// Preserved verbatim from the Worker's fetch handler — only keyed by `coords.sandboxId`
// instead of the constant `'canvas'`.
export async function serveWorkspace(request: Request, env: Env, coords: SandboxCoords): Promise<Response> {
  const { sandboxId } = coords;
  const url = new URL(request.url);
  const sandbox = sandboxFor(env, sandboxId);
  // Warm fast path: the container's been up since a prior request, so the port
  // is still exposed — just proxy (1 round-trip). The handshake (setEnvVars,
  // getProcess, waitForPort, exposePort) only matters on a cold start, and
  // running it on every request added ~4 round-trips (~1s) to every module
  // fetch and every canvas drag. So skip it here and pay it only on a miss.
  // Clone up front so the cold-path retry has an UNCONSUMED body: the warm proxy
  // below does `new Request(request)`, which marks request's body used, so retrying
  // the same object throws "Cannot reconstruct a Request with a used body" for any
  // POST/PUT (e.g. a login) that falls through to the cold path. (#preview)
  const retryReq = request.clone();
  try {
    const res = await proxy(sandbox, request, sandboxId);
    // Treating every app 4xx/5xx as not-ready re-proxied each one and turned
    // failed POSTs into used-body 500s. (#preview) The body is only peeked for a
    // non-410 4xx/5xx — the 2xx/3xx fast path never touches it.
    if (res.status < 400) return res;
    if (res.status !== 410) {
      const peek = await res.clone().text().catch(() => '');
      if (decideWarm(res.status, () => peek) === 'serve') return res;
    }
  } catch {
    /* container unreachable — fall through to the cold path */
  }
  // Cold path: bring the stack up, (re)expose the port, retry once (with the clone).
  // Reaching here means the warm proxy reported the container isn't ready — it had
  // slept or been recycled. This log is the observer-effect-free PROOF of a sleep→wake
  // cycle: watch for it under `wrangler tail` after an idle window.
  console.log(`[cold] boot — container asleep/gone, cold-starting ${sandboxId} for ${url.pathname}`);
  try {
    await ensureStack(sandbox, env, coords);
    await sandbox.exposePort(VITE_PORT, { hostname: 'localhost', token: PREVIEW_TOKEN });
    return await proxy(sandbox, retryReq, sandboxId);
  } catch (e: unknown) {
    return new Response('canvas error:\n' + String((e as Error)?.stack ?? e), { status: 500 });
  }
}
