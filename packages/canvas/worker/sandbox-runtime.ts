import { getSandbox } from '@cloudflare/sandbox';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { resolveConnectorEnv } from './connector-secrets.ts';
import type { Env } from './index.ts';
import { CANVAS_CONTAINER_CWD, containerEnv, warehouseContainerEnv } from './container-env.ts';
import type { CanvasBootSpec } from './canvas-boot.ts';
import { singleFlight } from './single-flight.ts';
import { selfHostedTarget, serveSelfHosted, staysOnContainer } from './self-hosted.ts';
import { type SandboxCoords, decideWarm, localBridgeOrigin, sseRetryResponse, wantsEventStream } from './sandbox-resolver.ts';

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
const START = `bash -lc "cd ${CANVAS_CONTAINER_CWD} && exec bun run scripts/container-start.ts"`;

// keepAlive + sleepAfter persist in the DO's storage across deploys; if keepAlive is
// ever stuck `true`, the container NEVER auto-sleeps and sleepAfter is ignored entirely
// (per @cloudflare/sandbox). Passing them to getSandbox re-applies the config via
// configure() on every entry, forcing keepAlive OFF and re-asserting sleepAfter — cheap
// hygiene so a stray keepAlive can't silently pin the container forever.
const SLEEP_AFTER = '5m';

/** The DO stub for a resolved workspace's container. */
export const sandboxFor = (env: Env, sandboxId: string) =>
  getSandbox(env.Sandbox, sandboxId, { normalizeId: true, keepAlive: false, sleepAfter: SLEEP_AFTER });

// The Warehouse container's runtime wiring (#240, ADR-0017; moved here from index.ts for
// #248 so both the cron dispatch AND the "Run now" manual trigger — HTTP route + MCP tool —
// can reach it without an import cycle through index.ts). Unlike the canvas container, the
// Warehouse container runs no bridge/vite server to proxy into (it carries no agent SDK,
// #236) — dispatch is a single `exec` of the pipeline's CLI entrypoint
// (warehouse/materialize.ts, baked into the image at the same WORKDIR as the canvas
// package — Dockerfile.warehouse). `materializeWorkspace`'s CLI entry (`import.meta.main`)
// reads the target workspace off `CANVAS_WORKSPACE`, same env var the canvas container's
// bridge uses to scope R2 state.
const MATERIALIZE_COMMAND = 'bun run warehouse/materialize.ts';

/** One-shot exec against the workspace's Warehouse container — `getSandbox` wakes it on
 *  demand (cold boot pulls the image if needed), same as the canvas container's proxy
 *  path, no separate "ensure started" step needed for a one-shot command. NOTE: this
 *  module is wholesale `mock.module`-replaced in worker/index.test.ts and
 *  worker/inbox-bridge.test.ts (`mock.module('@cloudflare/sandbox', () => ({ ... }))`) —
 *  any new named import from `@cloudflare/sandbox` anywhere in this file's module graph
 *  must be added to BOTH factories, or unrelated test files that transitively load this
 *  module will fail with "export not found" against the mock, not the real package. */
export const warehouseExec = async (env: Env, coords: SandboxCoords) => {
  const sandbox = getSandbox(env.Warehouse, coords.sandboxId, { normalizeId: true });
  // Connector secrets (#241): decrypted per-workspace so the pipeline's dlt sources can
  // read from them. `coords.canvasWorkspace` is the same id the R2 prefix and the DB
  // workspace row share (v1: one container = one workspace).
  const connectorEnv = await resolveConnectorEnv(env, createDbForWorker(env as unknown as Bindings), coords.canvasWorkspace);
  const result = await sandbox.exec(MATERIALIZE_COMMAND, {
    cwd: CANVAS_CONTAINER_CWD,
    // CANVAS_WORKSPACE scopes the pipeline's R2 read/write, same key the canvas
    // container's bridge uses — materialize.ts's CLI entry reads it directly.
    env: { ...warehouseContainerEnv(env, connectorEnv), CANVAS_WORKSPACE: coords.canvasWorkspace },
  });
  return { success: result.success, stdout: result.stdout, stderr: result.stderr };
};

type SandboxStub = ReturnType<typeof getSandbox>;

/** Everything the container's boot needs, resolved here (the Worker holds the secrets)
 *  and handed to the DO as one plain object. The `.env` file goes into the canvas package
 *  — the bridge's cwd — so bun auto-loads it for the bridge and every child, including
 *  web-poc's mounted app (auth secrets). */
const bootSpec = (env: Env, coords: SandboxCoords): CanvasBootSpec => ({
  processId: 'canvas',
  start: START,
  port: VITE_PORT,
  previewToken: PREVIEW_TOKEN,
  envFilePath: `${CANVAS_CONTAINER_CWD}/.env`,
  envVars: containerEnv(env, coords),
});

// Concurrent cold requests for the same container share ONE boot (#138). Module-scoped so it
// collapses the per-page-load stampede (~40 requests) within an isolate; keyed by sandbox id so a
// product boot never blocks the dev-agent's. Cleared when the boot settles (see singleFlight).
const inflightBoot = new Map<string, Promise<void>>();

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
  // E2E ONLY (#276): no container exists locally, so the workspace IS the bridge process on a
  // loopback port. Reached only AFTER the gate and the ownership check upstream, so it bypasses
  // nothing that guards a request — it only replaces the transport into the container.
  const localBridge = localBridgeOrigin(env);
  if (localBridge) {
    const target = new URL(url.pathname + url.search, localBridge);
    return fetch(new Request(target, request));
  }
  // A workspace whose compute lives on our own hardware (worker/self-hosted.ts).
  // Placed AFTER the gate and the ownership check upstream, exactly like the E2E
  // shim above: it changes the transport into the workspace and nothing about who
  // is allowed to reach it. Returns null unless the workspace is mapped AND all
  // three credentials are present, so a partial rollout serves from the container.
  // `staysOnContainer` keeps container-describing routes (/api/buildrev) on the
  // container even for a self-hosted workspace — see its docstring.
  const selfHosted = staysOnContainer(url.pathname) ? null : selfHostedTarget(env, coords.canvasWorkspace);
  if (selfHosted) return serveSelfHosted(request, selfHosted, containerEnv(env, coords), coords);
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
  // `Request.clone()`'s ambient type carries the CfProperties<Cf> generic in a shape
  // TS won't re-widen to the bare `Request` that `proxy()` expects — same runtime
  // object, just re-asserted to the type `request` itself already had.
  const retryReq = request.clone() as Request;
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
  // A stream (EventSource) request must NEVER see a non-SSE error out of the cold
  // path — that closes the client permanently (no auto-reconnect) and the tab's
  // canvas sync/presence is dead until a manual refresh. Errors on this path are
  // transient by construction (the container is booting), so hand streams a
  // retryable empty event stream instead. Warm-path app responses are untouched.
  const streamReq = wantsEventStream(request.headers.get('accept'));
  try {
    // The boot runs INSIDE the DO (`Sandbox.ensureCanvasStack`, worker/index.ts), which is
    // where the authoritative lock lives: one DO per sandbox id ⇒ one boot per container
    // across every isolate, and a boot that survives the cancellation of the request that
    // asked for it (incident 2026-08-13; canvas-boot.ts has the full account).
    //
    // This local single-flight stays in front of it as a cheap collapse, not as the
    // correctness mechanism: a page load fires ~40 requests at a sleeping container (#138),
    // and there is no reason to send 40 RPCs to learn the same answer. It is module-scoped,
    // so it only ever covered THIS isolate — which is exactly why the real lock had to move.
    await singleFlight(inflightBoot, sandboxId, () => sandbox.ensureCanvasStack(bootSpec(env, coords)));
    const res = await proxy(sandbox, retryReq, sandboxId);
    return streamReq && res.status >= 400 ? sseRetryResponse() : res;
  } catch (e: unknown) {
    if (streamReq) return sseRetryResponse();
    return new Response('canvas error:\n' + String((e as Error)?.stack ?? e), { status: 500 });
  }
}
