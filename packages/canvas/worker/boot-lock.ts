// The cold-boot lock: ONE boot of a workspace's stack at a time. Deliberately free of any
// `cloudflare:workers` import, so it is unit-testable off the edge runtime and shared with
// the self-hosted guest's supervisor (scripts/ws-supervisor.ts).
//
// WHY (incident 2026-08-13). The boot used to be awaited inside the request that triggered
// it. When that request died — a browser giving up on a hanging module fetch, an
// EventSource retrying — workerd canceled its outstanding RPCs, and the in-flight process
// start died with it. Production logs for that window: 223 `[cold] boot` lines in 131s and
// 39 process starts with outcome `canceled`, one every ~3s. Each new request found no
// process, started another, and got canceled in turn — a livelock the pad's own traffic
// (`/api/alive`, `/api/chat/stream`, a dozen transcript polls) fed indefinitely.
//
// Holding the boot on the container's DO fixes both halves at once: the DO is a single
// instance per workspace, so the lock is global rather than per-isolate, and the boot
// promise lives on the DO instance, so a caller that vanishes cannot take the boot down
// with it.

// After a boot FAILS, refuse to start another for this long. The 2026-08-13 storm retried
// ~2/s because `ProcessExitedBeforeReadyError` fails fast (the process is already gone, so
// there is no 120s wait to serve as a natural throttle) and the pad's heartbeats re-fire
// immediately. Sharing one in-flight boot does not help when each attempt has already
// finished failing by the time the next request arrives — only a floor on the retry rate
// does. Short enough that a human hitting reload gets a real attempt.
const RETRY_COOLDOWN_MS = 5_000;

/**
 * One boot at a time, per lock instance. Held on the CanvasContainer DO (one instance per
 * workspace ⇒ one boot per container, across every isolate and every request), and by the
 * self-hosted guest's supervisor (scripts/ws-supervisor.ts).
 *
 * Three properties, each paid for by the incident above:
 *  1. Concurrent callers AWAIT the same boot instead of racing kill+startProcess.
 *  2. `hold` (the DO's `ctx.waitUntil`) keeps the boot running when its caller is canceled
 *     — and because the promise lives on the lock, the next request joins that same boot
 *     rather than starting a rival one, which is the property that breaks the livelock.
 *  3. A failed boot is not retried immediately (RETRY_COOLDOWN_MS).
 *
 * `now` is injectable for tests only.
 */
export class BootLock {
  #inflight: Promise<void> | null = null;
  #failedAt = 0;
  #lastError: unknown = null;
  readonly #hold?: (p: Promise<unknown>) => void;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(opts: { hold?: (p: Promise<unknown>) => void; cooldownMs?: number; now?: () => number } = {}) {
    this.#hold = opts.hold;
    this.#cooldownMs = opts.cooldownMs ?? RETRY_COOLDOWN_MS;
    this.#now = opts.now ?? (() => Date.now());
  }

  run(boot: () => Promise<void>): Promise<void> {
    const existing = this.#inflight;
    if (existing) return existing;
    if (this.#failedAt && this.#now() - this.#failedAt < this.#cooldownMs) {
      return Promise.reject(this.#lastError ?? new Error('canvas boot failed moments ago; cooling down'));
    }
    const started: Promise<void> = boot()
      .then(
        () => {
          this.#failedAt = 0;
          this.#lastError = null;
        },
        (e: unknown) => {
          this.#failedAt = this.#now();
          this.#lastError = e;
          throw e;
        },
      )
      // Clear on settle (success OR failure) so the NEXT cold cycle — after the container
      // sleeps again — starts a fresh boot rather than reusing a stale settled promise. The
      // identity guard makes sure a settled boot only clears its OWN entry, never a newer one.
      .finally(() => {
        if (this.#inflight === started) this.#inflight = null;
      });
    this.#inflight = started;
    // Every rejection reaches a caller, but a caller that has been canceled is no longer
    // listening — so hold a handled reference of our own rather than leave it unhandled.
    void started.catch(() => {});
    this.#hold?.(started.catch(() => {}));
    return started;
  }
}
