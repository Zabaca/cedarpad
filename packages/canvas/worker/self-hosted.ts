// Serving a workspace whose container is not a Cloudflare Container.
//
// One workspace's compute can live on hardware we own (an incus guest on
// ryzen-9, reached through a Cloudflare Tunnel at ws.cedarpad.com) while every
// other workspace stays on the Sandbox DO. The workspace's DATA does not move:
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

import { decideWarm, sseRetryResponse, wantsEventStream } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

/**
 * Paths that must be answered by the Cloudflare container even when the
 * workspace is self-hosted.
 *
 * `/api/buildrev` reports the CONTAINER IMAGE's build stamp, and `deploy.sh`
 * polls it to confirm a rollout is serving the new SHA. A self-hosted guest runs
 * from a git checkout with no baked stamp, so it answers `dev` — and on
 * 2026-08-14 that made the deploy poll count 60 attempts against a value that
 * could never match, failing a deploy whose Worker had in fact shipped fine.
 *
 * The rule this encodes is not "special-case the deploy script": it is that a
 * question ABOUT the container has to be answered BY the container. Moving a
 * workspace's compute changes where the pad is served from, not what the
 * container image is.
 *
 * Pure; exported for tests.
 */
export function staysOnContainer(pathname: string): boolean {
  return pathname === '/api/buildrev';
}

/** Everything needed to reach one self-hosted workspace. */
export interface SelfHostedTarget {
  /** Origin of the guest's tunnel, e.g. `https://ws.cedarpad.com`. */
  origin: string;
  /** Bearer the supervisor's `/__boot` demands (belt, inside Access's braces). */
  supervisorToken: string;
  accessClientId: string;
  accessClientSecret: string;
}

export interface SelfHostedEnv {
  /** JSON map of canvasWorkspace id -> origin. Absent/empty ⇒ nothing is self-hosted. */
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
 * workspace is self-hosted", which routes everything back to the Sandbox DO —
 * the configuration that has always worked. Throwing would take every
 * workspace down, including the ones this feature never touched, over a typo in
 * a var that concerns one of them.
 *
 * Only `https:` origins are accepted: the token below is a bearer credential,
 * and putting it on the wire in cleartext to save a scheme is not a trade.
 * Pure; exported for tests.
 */
export function parseWorkspaceMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [workspace, origin] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof origin !== 'string') continue;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    // Normalised to a bare origin — a stray path would silently prefix every
    // request and produce 404s that look like the guest is broken.
    out[workspace] = url.origin;
  }
  return out;
}

/**
 * The self-hosted target for this workspace, or null to use the Sandbox DO.
 *
 * Returns null when ANY of the three credentials is missing, even though the
 * map names an origin. A half-configured target is the dangerous state: the
 * proxy would reach Access, be refused, and every request for that workspace
 * would fail — whereas falling back to the container is merely the old
 * behaviour. Config that is not complete is config that is not in effect.
 */
export function selfHostedTarget(env: SelfHostedEnv, canvasWorkspace: string): SelfHostedTarget | null {
  const origin = parseWorkspaceMap(env.SELF_HOSTED_WORKSPACES)[canvasWorkspace];
  if (!origin) return null;
  const supervisorToken = env.WS_SUPERVISOR_TOKEN ?? '';
  const accessClientId = env.CF_ACCESS_CLIENT_ID ?? '';
  const accessClientSecret = env.CF_ACCESS_CLIENT_SECRET ?? '';
  if (!supervisorToken || !accessClientId || !accessClientSecret) return null;
  return { origin, supervisorToken, accessClientId, accessClientSecret };
}

/** Build the guest-bound request: same path, same method, same body, plus Access. */
export function guestRequest(request: Request, origin: string, target: SelfHostedTarget): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('CF-Access-Client-Id', target.accessClientId);
  headers.set('CF-Access-Client-Secret', target.accessClientSecret);
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
    if (res.status < 400) return res;
    if (res.status !== 410) {
      const peek = await res.clone().text().catch(() => '');
      if (decideWarm(res.status, () => peek) === 'serve') return res;
    }
  } catch {
    /* guest unreachable — fall through and try to boot it */
  }

  console.log(`[self-hosted] boot — pushing env to ${target.origin} for ${coords.canvasWorkspace}`);
  try {
    // The guest holds NO cedarpad credential at rest; it starts the stack only
    // when this push arrives. `/__boot` is idempotent (`already: true` when the
    // stack is already serving), so a warm miss caused by something other than
    // a stopped stack costs one cheap round trip rather than a restart.
    const booted = await fetch(`${target.origin}/__boot`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.supervisorToken}`,
        'content-type': 'application/json',
        'CF-Access-Client-Id': target.accessClientId,
        'CF-Access-Client-Secret': target.accessClientSecret,
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
