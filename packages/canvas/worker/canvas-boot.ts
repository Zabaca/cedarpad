// The container cold boot — the sequence itself, plus the lock that makes ONE of them
// happen at a time. Deliberately free of any `@cloudflare/sandbox` /
// `cloudflare:workers` import: it operates on the structural `BootableSandbox` below, so
// it is unit-testable off the edge runtime AND callable from two places that cannot
// import each other's runtime — the Worker (through the DO stub) and the Sandbox DO
// itself (through `this`).
//
// WHY IT MOVED OUT OF sandbox-runtime.ts (incident 2026-08-13). The boot used to be
// awaited inside the request that triggered it. When that request died — a browser
// giving up on a hanging module fetch, an EventSource retrying — workerd canceled its
// outstanding RPCs, and the in-flight `startProcess` on the Sandbox DO died with it.
// Production logs for that window: 223 `[cold] boot` lines in 131s and 39 `startProcess`
// invocations with outcome `canceled`, one every ~3s. Each new request found no process,
// started another, and got canceled in turn — a livelock the pad's own traffic
// (`/api/alive`, `/api/chat/stream`, a dozen transcript polls) fed indefinitely. It
// cleared only when one attempt happened to outlive its caller. The symptom the user saw
// was `ProcessExitedBeforeReadyError: Process exited with code 0`.
//
// Running the boot INSIDE the DO fixes both halves at once: the DO is a single instance
// per sandbox id, so the lock below is global rather than per-isolate (the previous
// `single-flight.ts` collapse was module-scoped and never covered a second isolate), and
// the boot promise is held on the DO instance, so a caller that vanishes can no longer
// take the boot down with it.

/** The subset of the Sandbox surface a boot touches. Both the DO stub and the DO's own
 *  `this` satisfy it — which is the point: one sequence, two call sites, no duplication. */
export interface BootableSandbox {
  setEnvVars(vars: Record<string, string>): Promise<unknown>;
  getProcess(id: string): Promise<{ waitForPort(port: number, options?: { timeout?: number }): Promise<void> } | null>;
  writeFile(path: string, content: string): Promise<unknown>;
  startProcess(
    command: string,
    options: { processId: string; envVars: Record<string, string> },
  ): Promise<{ waitForPort(port: number, options?: { timeout?: number }): Promise<void> }>;
  killProcess(id: string): Promise<unknown>;
  exposePort(port: number, options: { hostname: string; token: string }): Promise<unknown>;
}

/** Everything the boot needs to know, resolved by the Worker and passed across the RPC
 *  boundary as one plain object (structured-cloneable by construction). */
export interface CanvasBootSpec {
  /** The process id the stack runs under — the handle `getProcess`/`killProcess` use. */
  processId: string;
  /** The command that starts the dev stack (vite + bridge). */
  start: string;
  /** The port vite binds, which the edge proxy forwards to. */
  port: number;
  /** Preview-proxy token the exposed port is published under. */
  previewToken: string;
  /** Absolute path of the `.env` file written before a FRESH start (see below). */
  envFilePath: string;
  /** The container's environment — creds included. */
  envVars: Record<string, string>;
}

// Generous first wait: a cold vite boot (esp. the first pull of a new image) can take
// tens of seconds; a short timeout would kill a healthy-but-slow boot and restart it
// pointlessly. 40s was too short: on a heavy boot vite bound after it, so the worker
// killProcess'd a healthy stack — orphaning the already-bound bridge, so the restart hit
// EADDRINUSE, exited code 0, and surfaced as ProcessExitedBeforeReadyError (intermittent
// 502 / ~100s boots after an idle sleep). Reproduced + fixed in the sleep spike: 120s lets
// a slow-but-healthy boot finish.
const PORT_TIMEOUT_MS = 120_000;

// Write the creds to .env in the container so bun auto-loads them for the bridge and every
// child. setEnvVars / ProcessOptions.envVars proved racy across recycles (the bridge
// intermittently came up with no R2 creds and silently used local-fs); a file bun reads at
// startup is deterministic. Only called before a FRESH start — never while the bridge runs,
// so `bun --watch` can't restart-loop on .env churn.
async function writeEnvFile(sandbox: BootableSandbox, spec: CanvasBootSpec): Promise<void> {
  const body =
    Object.entries(spec.envVars)
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join('\n') + '\n';
  await sandbox.writeFile(spec.envFilePath, body).catch(() => {});
}

/** Start (or recover) the dev stack, wait for vite, and publish the port. Mirrors the
 *  spike's warm/stale handling: try the running process, else start fresh; on a cold boot
 *  give vite + bridge time to come up (node_modules is image-resident, so no install).
 *  `exposePort` is the last step and lives here rather than at the call site so it happens
 *  once per boot, under the same lock, instead of once per request. */
export async function bootCanvasStack(sandbox: BootableSandbox, spec: CanvasBootSpec): Promise<void> {
  // No git token is minted at boot (ADR-0010): the dev-agent's token is per-turn, minted by the
  // edge chat proxy onto each dev-agent send (worker/inbox-bridge.ts) — never container env.
  await sandbox.setEnvVars(spec.envVars).catch(() => {}); // kept as a secondary path
  const opts = { processId: spec.processId, envVars: spec.envVars } as const;
  let proc = await sandbox.getProcess(spec.processId).catch(() => null);
  if (!proc) {
    await writeEnvFile(sandbox, spec); // creds in place BEFORE the bridge starts
    proc = await sandbox.startProcess(spec.start, opts).catch(() => null);
  }
  const up = proc
    ? await proc
        .waitForPort(spec.port, { timeout: PORT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false)
    : false;
  if (!up) {
    await sandbox.killProcess(spec.processId).catch(() => {});
    await writeEnvFile(sandbox, spec);
    const fresh = await sandbox.startProcess(spec.start, opts);
    await fresh.waitForPort(spec.port, { timeout: PORT_TIMEOUT_MS });
  }
  await sandbox.exposePort(spec.port, { hostname: 'localhost', token: spec.previewToken });
}

// After a boot FAILS, refuse to start another for this long. The 2026-08-13 storm retried
// ~2/s because `ProcessExitedBeforeReadyError` fails fast (the process is already gone, so
// there is no 120s wait to serve as a natural throttle) and the pad's heartbeats re-fire
// immediately. Sharing one in-flight boot does not help when each attempt has already
// finished failing by the time the next request arrives — only a floor on the retry rate
// does. Short enough that a human hitting reload gets a real attempt.
const RETRY_COOLDOWN_MS = 5_000;

/**
 * One boot at a time, per lock instance. Held on the Sandbox DO (one instance per sandbox
 * id ⇒ one boot per container, across every isolate and every request).
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
