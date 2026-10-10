// The decisions `CanvasContainer` (worker/canvas-container.ts) makes about its container,
// kept free of any `cloudflare:workers` import so they test under bun. The shape follows
// zbc's walgit (packages/walgit/shared/container-lifecycle.ts), which has run the
// `durable_object` scheduling policy in production since 2026-10-03; the numbers are
// cedarpad's own.

/** The key under `containers[].images` in wrangler.jsonc. Wrangler builds the Dockerfile it
 *  names and hands the DO a digest-pinned reference as `ctx.container.images.canvas`. */
export const IMAGE_NAME = 'canvas';

/** Worker → DO only: the workspace's resolved coordinates, JSON. Overwritten by the Worker on
 *  every request and stripped by the DO before the container sees it, so a client-sent copy
 *  never decides anything. */
export const COORDS_HEADER = 'x-canvas-container-coords';

/** Vite. It serves the pad and proxies `/api/*` to the bridge on :4511, so one port is the
 *  whole container as far as the edge is concerned. */
export const CONTAINER_PORT = 4510;

/** A bridge route answered through vite, so one probe proves BOTH processes are up. */
export const READY_PATH = '/api/health';

/** The instance size. Measured on preview 2026-10-09: ~4s to a serving stack from idle. */
export const CONTAINER_INSTANCE = 'standard-1';

/** How long a start may take before it is given up. Deliberately generous: a cold vite boot
 *  took 30–120s on the retired Sandbox, and the first boot of a new image on a host is ~30s
 *  here — a short timeout would destroy a healthy, slow boot. */
export const READY_TIMEOUT_MS = 180_000;
export const READY_POLL_MS = 500;
export const READY_PROBE_TIMEOUT_MS = 5_000;

/** Idle time, after the last request FINISHED, before the container is stopped. */
export const SLEEP_AFTER_MS = 5 * 60_000;

/** How long a SIGTERM'd stack gets to exit before it is destroyed. */
export const STOP_GRACE_MS = 15_000;

/** A request still open after this stops counting as in flight, so a client that never
 *  reads its body cannot pin the container up for good. */
export const INFLIGHT_MAX_MS = 60 * 60_000;

/** The platform's backstop for an idle DO: the alarm's deadline plus a margin, capped at
 *  the 6h the API accepts. Without one, the container is stopped seconds after the DO goes
 *  idle — before the alarm can stop it gracefully. */
export function inactivityTimeoutMs(sleepAfterMs: number): number {
  return Math.min(sleepAfterMs + 2 * 60_000, 6 * 60 * 60_000);
}

export type IdleVerdict = { stop: true } | { stop: false; at: number };

/** What the idle alarm should do: never stop with a request in flight, and otherwise stop
 *  once `sleepAfterMs` has passed since the last one finished. */
export function idleVerdict(state: {
  now: number;
  inflight: number;
  lastActivity: number | null;
  sleepAfterMs: number;
}): IdleVerdict {
  const { now, inflight, lastActivity, sleepAfterMs } = state;
  if (inflight > 0) return { stop: false, at: now + sleepAfterMs };
  if (lastActivity === null) return { stop: true };
  const due = lastActivity + sleepAfterMs;
  return due <= now ? { stop: true } : { stop: false, at: due };
}

/** When a finished request should move the alarm to, or null to leave it: re-arming on every
 *  request is a storage write per module fetch, so an alarm already close enough stays. */
export function rearmAt(state: { now: number; scheduled: number | null; sleepAfterMs: number }): number | null {
  const { now, scheduled, sleepAfterMs } = state;
  const deadline = now + sleepAfterMs;
  const slack = Math.min(sleepAfterMs / 10, 30_000);
  if (scheduled !== null && scheduled >= deadline - slack) return null;
  return deadline;
}

/** A bodiless read that lands on a container that just exited is safe to send again. */
export function mayRetry(method: string, attempt: number): boolean {
  return attempt === 0 && (method === 'GET' || method === 'HEAD');
}

/**
 * What a running container was booted from: the image AND its environment. The policy has
 * no rollouts, so a container whose fingerprint no longer matches what this deploy would
 * start is destroyed, and that is the whole of how a new image or a rotated secret reaches
 * it. A hash, not the values, so storage never holds a secret. FNV-1a: this is identity,
 * not security, and it must be synchronous and dependency-free.
 */
export function bootFingerprint(image: string, env: Record<string, string>): string {
  const canonical = JSON.stringify([image, Object.keys(env).sort().map((k) => [k, env[k]])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
