// Serving a workspace whose container is not a Cloudflare Container.
//
// One workspace's compute can live on hardware we own (today `default`, in an sbx
// sandbox on the sandbox site, reached at its own addresses; ADR-0028) while every
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
// rather than the rare one. A sandbox keeps its disk across sleep, so it pre-bundles
// once and never again. (The first home of this path was a self-hosted VM, which
// held 8.5 GiB of memory while idle; it was deleted on 2026-11-09.)
//
// ── The trust boundary is unchanged ───────────────────────────────────────
// The browser NEVER talks to the sandbox. It talks to this Worker, which has
// already run Better Auth and the workspace ownership check (shell-routing.ts),
// exactly as it does for a container-backed workspace. The Worker then presents
// a Cloudflare Access service token to reach the sandbox. So its two addresses
// (each behind an Access application declared outside this repository) admit precisely one caller,
// and the authorization that matters still happens here. That is why the Access
// policy carries no email rule: a human who could satisfy Access directly would
// bypass the ownership check.
//
// ── Two kinds of target ───────────────────────────────────────────────────
// A sandbox on the sandbox site (sbx) has one address per port: the stack at
// `<name>.sbx.zabaca.com`, the supervisor at `4599-<name>.sbx.zabaca.com`. Its map
// entry names both, and it is the one that sleeps: every request the Worker
// forwards to it asks sbx to wake it (`WAKE_HEADER`), and sbx's 410 ("lost") is
// treated as a stack that is down, because a sandbox flagged start-fresh starts
// again from its image when the boot arrives.
//
// The other form, a plain origin (one address for the stack and the supervisor, as the
// retired VM's tunnel hostname had), is still parsed and tested and the admin page labels
// it `VM`. Nothing is mapped that way now: it is supported code, left alone so this
// clean-up does not refactor the Worker.

import { z } from 'zod';

import { sseRetryResponse, urlOnOrigin, wantsEventStream } from './sandbox-resolver.ts';
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
  /** Origin of the stack (vite): a plain-origin entry's address, or a sandbox's own address. */
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
  const map = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!map.success) return {};
  const out: Record<string, WorkspaceOrigins> = {};
  for (const [workspace, value] of Object.entries(map.data)) {
    // One bad entry is dropped on its own; the others stand.
    const entry = WorkspaceEntry.safeParse(value);
    if (entry.success) out[workspace] = entry.data;
  }
  return out;
}

/**
 * A bare `https:` origin. Normalised to the origin, because a stray path would silently prefix every
 * request and produce 404s that look like the guest is broken.
 */
const HttpsOrigin = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.origin;
  } catch {
    /* falls through to the issue */
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not an https origin' });
  return z.NEVER;
});

/**
 * One workspace's entry in `SELF_HOSTED_WORKSPACES` (a single contract, CLAUDE.md section 7): a plain origin, the VM,
 * which serves the stack and the supervisor both; or `{ stack, supervisor }`, a sandbox, whose two addresses are both
 * required (one alone could not boot the stack it serves).
 */
const WorkspaceEntry = z.union([
  HttpsOrigin.transform((origin) => ({ origin, supervisorOrigin: origin, sandbox: false })),
  z
    .object({ stack: HttpsOrigin, supervisor: HttpsOrigin })
    .transform(({ stack, supervisor }) => ({ origin: stack, supervisorOrigin: supervisor, sandbox: true })),
]);

/** One workspace's entry in the map; the fields of a `SelfHostedTarget` that the map decides. */
export type WorkspaceOrigins = z.infer<typeof WorkspaceEntry>;

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
 * does not survive. `wake` is '0' for a request that must only look (the public build stamp): sbx then answers
 * "asleep" instead of waking the sandbox, and does not count the request as use.
 */
export function guestRequest(request: Request, origin: string, target: SelfHostedTarget, wake: '1' | '0' = '1'): Request {
  const headers = new Headers(request.headers);
  headers.set('CF-Access-Client-Id', target.accessClientId);
  headers.set('CF-Access-Client-Secret', target.accessClientSecret);
  if (target.sandbox) headers.set(WAKE_HEADER, wake);
  return new Request(urlOnOrigin(request.url, origin), new Request(request, { headers }));
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
  opts: { passive?: boolean } = {},
): Promise<Response> {
  // Passive: the request only looks. On a sandbox that is the public build stamp, which anyone can poll, so it must not
  // wake a sleeping sandbox or boot a stopped stack (an anonymous poll would keep the workspace awake for good): it is
  // answered if the stack is up, and with a 503 otherwise. The VM has no wake to ask for and is served as before.
  const passive = opts.passive === true && target.sandbox;
  const retryReq = request.clone() as Request;
  const streamReq = wantsEventStream(request.headers.get('accept'));
  try {
    const res = await fetch(guestRequest(request, target.origin, target, passive ? '0' : '1'));
    if (decideGuestWarm(res.status, target.sandbox) === 'serve') return res;
  } catch {
    /* guest unreachable — fall through and try to boot it */
  }
  if (passive) {
    return new Response(JSON.stringify({ error: 'the workspace is asleep or its stack is not running' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' },
    });
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
