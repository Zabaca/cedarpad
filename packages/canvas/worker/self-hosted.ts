// Serving a workspace whose container is not a Cloudflare Container.
//
// One workspace's compute can live on hardware we own (an incus guest on
// ryzen-9, reached through a Cloudflare Tunnel at ws.cedarpad.com) while every
// other workspace runs on its CanvasContainer. The workspace's DATA does not move:
// canvas state is in CanvasSyncRoom, platform rows are in D1, artifacts are in
// R2 (ADR-0022 — content is records, not files). Only the process that serves
// the pad and runs the agent changes address.
//
// ── Why this exists at all ────────────────────────────────────────────────
// The Cloudflare container's filesystem does not survive sleep, so vite's
// dependency pre-bundle (`node_modules/.vite/deps`) is rebuilt on every cold
// boot. On 2026-08-14 that raced a page load in production: tldraw.js was
// served referencing `chunk-U6BVBC5J.js` before the chunk was written, the
// browser got a 404, tldraw never loaded, and the canvas stayed blank with no
// retry. The aggressive idle reaper (90s) made a cold boot the common case
// rather than the rare one. A guest with a persistent disk pre-bundles once and
// never again.
//
// ── The trust boundary is unchanged ───────────────────────────────────────
// The browser NEVER talks to the guest. It talks to this Worker, which has
// already run Better Auth and the workspace ownership check (shell-routing.ts),
// exactly as it does for a container-backed workspace. The Worker then presents
// a Cloudflare Access service token to reach the guest. So the guest's hostname
// admits precisely one caller, and the authorization that matters still happens
// here. That is why the Access policy carries no email rule: a human who could
// satisfy Access directly would bypass the ownership check.
//
// ── Two kinds of target ───────────────────────────────────────────────────
// The VM is reached through one tunnel hostname that routes `/__boot` to the
// supervisor and everything else to vite, so its map entry is a plain origin.
// A sandbox on the sandbox site (sbx) has one address per port instead: the
// stack at `<name>.sbx.zabaca.com`, the supervisor at `4599-<name>.sbx.zabaca.com`.
// Its entry names both, and it is the one that sleeps: every request the Worker
// forwards to it asks sbx to wake it (`WAKE_HEADER`), and sbx's 410 ("lost") is
// treated as a stack that is down, because a sandbox flagged start-fresh starts
// again from its image when the boot arrives.

import { sseRetryResponse, wantsEventStream } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

/**
 * Warm-vs-cold for a request that went through a Cloudflare TUNNEL, which fails
 * differently from a container proxy.
 *
 * The retired Sandbox path's `decideWarm` encoded its preview proxy's not-ready
 * signals: a 410, or a body carrying `INVALID_TOKEN` / `port not exposed`.
 * cloudflared emits none of those. When the guest's origin is not listening it
 * answers with Cloudflare's own **502** page, which matched nothing in
 * `decideWarm` and so was classified `serve` — and on 2026-08-14 that put a
 * "Bad gateway" error page in front of a user whose guest merely needed
 * booting. Reusing one decision function for two transports was the bug.
 *
 * 502/503/504 from the edge mean the origin is unreachable, unavailable, or
 * timed out — in every case, not serving. The asymmetry justifies being blunt:
 * a false positive costs one `/__boot`, which is idempotent and answers
 * `already: true` in milliseconds when the stack is fine. A false negative is
 * what you just saw — a permanent error page that never retries. Vite and the
 * bridge do not produce these statuses in normal operation.
 *
 * Everything else is a REAL app response and passes through untouched: a failed
 * login is a legitimate 401, not a reason to restart the workspace.
 *
 * Pure; exported for tests.
 */
export function decideGuestWarm(status: number, sandbox = false): 'serve' | 'cold-start' {
  if (status < 400) return 'serve';
  // sbx answers 410 for a sandbox whose pod is gone. For one that starts fresh when lost that is a stack that is
  // down, like a 502; behind the VM's tunnel nothing answers 410, so there it is a real response.
  if (sandbox && status === 410) return 'cold-start';
  return status === 502 || status === 503 || status === 504 ? 'cold-start' : 'serve';
}

/** sbx's request header that wakes a sleeping sandbox whatever the request looks like (a bot's User-Agent, a HEAD). */
export const WAKE_HEADER = 'X-Sbx-Wake';

/** Everything needed to reach one self-hosted workspace. */
export interface SelfHostedTarget {
  /** Origin of the stack (vite): the guest's tunnel, e.g. `https://ws.cedarpad.com`, or a sandbox's own address. */
  origin: string;
  /** Origin of the supervisor's `/__boot`: the same as `origin` behind the VM's tunnel, its own address on a sandbox. */
  supervisorOrigin: string;
  /** A sandbox on sbx: it sleeps, so its requests ask to wake it and its 410 is a cold start. */
  sandbox: boolean;
  /** Bearer the supervisor's `/__boot` demands (belt, inside Access's braces). */
  supervisorToken: string;
  accessClientId: string;
  accessClientSecret: string;
}

export interface SelfHostedEnv {
  /**
   * JSON map of canvasWorkspace id -> where its compute is. Absent/empty ⇒ nothing is self-hosted. A value is a plain
   * origin (the VM: one address for the stack and the supervisor) or `{ "stack": origin, "supervisor": origin }` (a sandbox).
   */
  SELF_HOSTED_WORKSPACES?: string;
  WS_SUPERVISOR_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

/**
 * Parse the workspace→origin map. Returns an empty map on anything malformed
 * rather than throwing.
 *
 * Failing OPEN here is the deliberate choice, and it is the opposite of what a
 * parser normally should do. This map is the only thing that moves a workspace
 * off Cloudflare; if it is unreadable, the honest interpretation is "no
 * workspace is self-hosted", which routes everything back to its CanvasContainer —
 * the configuration that has always worked. Throwing would take every
 * workspace down, including the ones this feature never touched, over a typo in
 * a var that concerns one of them.
 *
 * Only `https:` origins are accepted: the token below is a bearer credential,
 * and putting it on the wire in cleartext to save a scheme is not a trade.
 * Pure; exported for tests.
 */
export function parseWorkspaceMap(raw: string | undefined): Record<string, WorkspaceOrigins> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, WorkspaceOrigins> = {};
  for (const [workspace, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const origin = httpsOrigin(value);
      if (origin) out[workspace] = { origin, supervisorOrigin: origin, sandbox: false };
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // A sandbox: both addresses or neither. One alone could not boot the stack it serves.
      const { stack, supervisor } = value as Record<string, unknown>;
      const origin = httpsOrigin(stack);
      const supervisorOrigin = httpsOrigin(supervisor);
      if (origin && supervisorOrigin) out[workspace] = { origin, supervisorOrigin, sandbox: true };
    }
  }
  return out;
}

/** One workspace's entry in the map; the fields of a `SelfHostedTarget` that the map decides. */
export interface WorkspaceOrigins {
  origin: string;
  supervisorOrigin: string;
  sandbox: boolean;
}

/**
 * A bare `https:` origin, or null. Normalised to the origin, because a stray path would silently prefix every
 * request and produce 404s that look like the guest is broken.
 */
function httpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The self-hosted target for this workspace, or null to use its CanvasContainer.
 *
 * Returns null when ANY of the three credentials is missing, even though the
 * map names an origin. A half-configured target is the dangerous state: the
 * proxy would reach Access, be refused, and every request for that workspace
 * would fail — whereas falling back to the container is merely the old
 * behaviour. Config that is not complete is config that is not in effect.
 */
export function selfHostedTarget(env: SelfHostedEnv, canvasWorkspace: string): SelfHostedTarget | null {
  const origins = parseWorkspaceMap(env.SELF_HOSTED_WORKSPACES)[canvasWorkspace];
  if (!origins) return null;
  const supervisorToken = env.WS_SUPERVISOR_TOKEN ?? '';
  const accessClientId = env.CF_ACCESS_CLIENT_ID ?? '';
  const accessClientSecret = env.CF_ACCESS_CLIENT_SECRET ?? '';
  if (!supervisorToken || !accessClientId || !accessClientSecret) return null;
  return { ...origins, supervisorToken, accessClientId, accessClientSecret };
}

/**
 * Build the guest-bound request: same path, same method, same body, plus Access. To a sandbox it also carries the
 * always-wake header: the Worker has already decided the caller may reach the workspace, so sbx must not judge the
 * request itself (it answers "asleep" to a bot's User-Agent or a HEAD). Set, not appended, so a caller's own value
 * does not survive.
 */
export function guestRequest(request: Request, origin: string, target: SelfHostedTarget): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('CF-Access-Client-Id', target.accessClientId);
  headers.set('CF-Access-Client-Secret', target.accessClientSecret);
  if (target.sandbox) headers.set(WAKE_HEADER, '1');
  return new Request(new URL(url.pathname + url.search, origin), new Request(request, { headers }));
}

/**
 * Warm-proxy-first, boot-on-miss — the same shape `serveWorkspace` uses for the
 * container, for the same reasons. The handshake costs a round trip, so it is
 * paid on a miss rather than on every module fetch.
 *
 * The clone up front matters for the identical reason it does there: the warm
 * proxy consumes the body, so a POST that falls through to the boot path needs
 * an unconsumed copy to retry with.
 */
export async function serveSelfHosted(
  request: Request,
  target: SelfHostedTarget,
  containerEnvVars: Record<string, string>,
  coords: SandboxCoords,
): Promise<Response> {
  const retryReq = request.clone() as Request;
  const streamReq = wantsEventStream(request.headers.get('accept'));
  try {
    const res = await fetch(guestRequest(request, target.origin, target));
    if (decideGuestWarm(res.status, target.sandbox) === 'serve') return res;
  } catch {
    /* guest unreachable — fall through and try to boot it */
  }

  console.log(`[self-hosted] boot: pushing env to ${target.supervisorOrigin} for ${coords.canvasWorkspace}`);
  try {
    // The guest holds NO cedarpad credential at rest; it starts the stack only
    // when this push arrives. `/__boot` is idempotent (`already: true` when the
    // stack is already serving), so a warm miss caused by something other than
    // a stopped stack costs one cheap round trip rather than a restart.
    const booted = await fetch(`${target.supervisorOrigin}/__boot`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.supervisorToken}`,
        'content-type': 'application/json',
        'CF-Access-Client-Id': target.accessClientId,
        'CF-Access-Client-Secret': target.accessClientSecret,
        ...(target.sandbox ? { [WAKE_HEADER]: '1' } : {}),
      },
      body: JSON.stringify(containerEnvVars),
    });
    if (!booted.ok) {
      const detail = await booted.text().catch(() => '');
      throw new Error(`supervisor /__boot ${booted.status}: ${detail.slice(0, 200)}`);
    }
    const res = await fetch(guestRequest(retryReq, target.origin, target));
    return streamReq && res.status >= 400 ? sseRetryResponse() : res;
  } catch (e: unknown) {
    // A stream must never see a non-SSE error: EventSource does not reconnect
    // after one, so the tab's canvas sync stays dead until a manual refresh.
    if (streamReq) return sseRetryResponse();
    return new Response('self-hosted workspace error:\n' + String((e as Error)?.stack ?? e), { status: 502 });
  }
}
