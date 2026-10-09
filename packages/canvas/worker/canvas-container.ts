// The workspace's dev stack (vite + bridge) on Cloudflare's `durable_object` container
// scheduling policy: this Durable Object drives `ctx.container` itself.
//
// Why a new class rather than the Sandbox with a new base: `@cloudflare/sandbox`'s Sandbox
// extends `@cloudflare/containers`' `Container`, which cannot run under this policy and is
// maintained only through 2026-12-31. A container application's policy is fixed when it is
// created, so this is a new namespace with its own application, routed to only when
// `CANVAS_CONTAINER=durable` (canvas-container-lifecycle.ts `containerChoice`). What the
// policy removes is the deploy machinery: there are no container rollouts, so no 408 on the
// application PATCH and no two-stage settle. A new image reaches a running container because
// its boot fingerprint no longer matches (`reconcile`, below).
//
// The lifecycle follows zbc's walgit (packages/walgit/worker/durable-container.ts):
//   - START: `start({ image, env })`, single-flighted on a `BootLock` held with
//     `ctx.waitUntil`, so the ~40 requests a page load fires at a cold container share one
//     boot and a canceled request cannot take the boot down (incident 2026-08-13,
//     canvas-boot.ts). `start()` returns before anything listens, so readiness is asked of
//     the port: READY_PATH through vite proves vite AND the bridge.
//   - PROXY: HTTP (SSE unbuffered) and WebSocket to vite on :4510, every request counted in
//     flight until its last byte leaves.
//   - STOP: an alarm SLEEP_AFTER_MS after the last request finished, never while one is in
//     flight: SIGTERM (container-start.ts exits on it), then destroy if it lingers.
//
// The env a workspace's container runs with depends on which workspace it is, and the DO
// knows only its id, so the Worker sends the resolved coordinates on every request
// (COORDS_HEADER). They are routing data, not secrets: the secrets come from `this.env`.
//
// A plain class rather than a `cloudflare:workers` `DurableObject` subclass, like
// CanvasSyncRoom: it is reached only through `stub.fetch`, never by RPC, and the import would
// make every bun test that loads the Worker entrypoint fail to resolve `cloudflare:workers`.

import { BootLock } from './canvas-boot.ts';
import {
  COORDS_HEADER,
  CONTAINER_INSTANCE,
  CONTAINER_PORT,
  IMAGE_NAME,
  INFLIGHT_MAX_MS,
  READY_PATH,
  READY_POLL_MS,
  READY_PROBE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  SLEEP_AFTER_MS,
  STOP_GRACE_MS,
  bootFingerprint,
  idleVerdict,
  inactivityTimeoutMs,
  mayRetry,
  rearmAt,
} from './canvas-container-lifecycle.ts';
import { containerEnv } from './container-env.ts';
import type { Env } from './index.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

/** Set on the first response after a real start, valued with the boot time in ms. */
export const COLD_HEADER = 'x-canvas-cold-boot-ms';

/** Debug routes the DO answers itself; the Worker forwards them behind the member gate. */
export const RECYCLE_PATH = '/__recycle';
export const BOOTLOG_PATH = '/__bootlog';

const FINGERPRINT_KEY = 'boot-fingerprint';
const LAST_BOOT_KEY = 'last-boot';
const SIGTERM = 15;

interface BootRecord {
  at: string;
  ms: number;
  outcome: 'ready' | 'failed';
  detail?: string;
}

export class CanvasContainer {
  #boot = new BootLock({ hold: (p) => this.ctx.waitUntil(p) });
  /** The boot under way. Checked BEFORE `running`, which turns true the moment `start()`
   *  returns — long before vite listens — so a request arriving mid-boot waits for it. */
  #starting: Promise<void> | null = null;
  #reconciled: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #inflight = 0;
  #lastActivity: number | null = null;
  #alarmAt: number | null = null;
  /** The boot time of a start THIS instance made, read and cleared by the next response. */
  #coldMs: number | null = null;
  /** One `monitor()` per start: a pending one keeps the DO resident for up to 15 minutes. */
  #exit: Promise<string> | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // The inactivity timeout belongs to the DO instance, not the container: one constructed
    // in front of a running container (a deploy, an eviction) has none until it is set again.
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(inactivityTimeoutMs(SLEEP_AFTER_MS)).catch((e: unknown) => {
          console.error(`[container] inactivity timeout not set: ${messageOf(e)}`);
        }),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const coords = JSON.parse(request.headers.get(COORDS_HEADER) ?? 'null') as SandboxCoords | null;
    if (!coords) return new Response('canvas container: no workspace coordinates', { status: 400 });
    const env = { ...containerEnv(this.env, coords), IS_SANDBOX: '1' };

    if (url.pathname === RECYCLE_PATH) {
      const r = await this.container.destroy().then(() => 'destroyed', (e: unknown) => messageOf(e));
      return Response.json({ recycle: r });
    }
    if (url.pathname === BOOTLOG_PATH) {
      return Response.json({
        running: this.container.running,
        lastBoot: (await this.ctx.storage.get<BootRecord>(LAST_BOOT_KEY)) ?? null,
      });
    }

    // Before anything is proxied, and only with nothing in flight: destroying the container
    // under an open stream would cut someone off mid-turn.
    if (!this.#reconciled && this.#inflight === 0) {
      this.#reconciled = this.reconcile(env).catch((e: unknown) => {
        this.#reconciled = null;
        console.error(`[container] reconcile failed: ${messageOf(e)}`);
      });
    }
    if (this.#reconciled) await this.#reconciled;

    this.#inflight += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      this.finished();
    };
    const cap = setTimeout(settle, INFLIGHT_MAX_MS);

    try {
      await this.ensureRunning(env);
    } catch (e) {
      settle();
      return new Response(`canvas container failed to start: ${messageOf(e)}`, { status: 503 });
    }

    const forwarded = new Request(request);
    forwarded.headers.delete(COORDS_HEADER);
    let response: Response;
    try {
      response = await this.forward(forwarded, env);
    } catch (e) {
      settle();
      return new Response(`canvas container proxy failed: ${messageOf(e)}`, { status: 502 });
    }

    if (response.webSocket) response = this.proxySocket(response, settle);
    else if (response.body) response = this.trackBody(response, settle);
    else settle();

    const cold = this.#coldMs;
    this.#coldMs = null;
    if (cold === null) return response;
    const stamped = new Response(response.body, response);
    stamped.headers.set(COLD_HEADER, String(cold));
    return stamped;
  }

  /** The idle stop. Armed only while a container runs; a fire that finds none returns
   *  without re-arming, which is what lets the DO itself sleep. */
  async alarm(): Promise<void> {
    this.#alarmAt = null;
    if (!this.ctx.container?.running) return;
    const verdict = idleVerdict({
      now: Date.now(),
      inflight: this.#inflight,
      lastActivity: this.#lastActivity,
      sleepAfterMs: SLEEP_AFTER_MS,
    });
    if (!verdict.stop) return this.arm(verdict.at);
    try {
      await this.stop();
    } catch (e) {
      console.error(`[container] idle stop failed: ${messageOf(e)}`);
      if (this.ctx.container?.running) await this.arm(Date.now() + 60_000);
    }
  }

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('no container is configured for this Durable Object');
    return container;
  }

  private image(): string {
    const image = this.container.images[IMAGE_NAME];
    if (!image) throw new Error(`no container image named "${IMAGE_NAME}" (wrangler.jsonc containers[].images)`);
    return image;
  }

  /** Destroy a running container this deploy would boot differently. Recorded only after a
   *  successful destroy (or when nothing runs), so a failed one is retried. */
  private async reconcile(env: Record<string, string>): Promise<void> {
    const current = bootFingerprint(this.image(), env);
    const booted = await this.ctx.storage.get<string>(FINGERPRINT_KEY);
    if (booted === current) return;
    if (this.container.running) {
      await this.container.destroy();
      console.log(`[container] boot fingerprint changed (${booted ?? 'unrecorded'} -> ${current}); container replaced`);
    }
    await this.ctx.storage.put(FINGERPRINT_KEY, current);
  }

  private async ensureRunning(env: Record<string, string>): Promise<void> {
    while (this.#stopping) await this.#stopping.catch(() => undefined);
    if (this.#starting) return this.#starting;
    if (this.container.running) return;
    const starting = this.#boot.run(() => this.boot(env)).finally(() => {
      if (this.#starting === starting) this.#starting = null;
    });
    this.#starting = starting;
    return starting;
  }

  private async boot(env: Record<string, string>): Promise<void> {
    const container = this.container;
    if (container.running) return;
    const image = this.image();
    const begun = Date.now();
    try {
      container.start({ image, env, enableInternet: true, instance: CONTAINER_INSTANCE });
    } catch (e) {
      throw new Error(`start refused: ${messageOf(e)}`);
    }
    this.#exit = null;
    await this.ctx.storage.put(FINGERPRINT_KEY, bootFingerprint(image, env));
    await container.setInactivityTimeout(inactivityTimeoutMs(SLEEP_AFTER_MS)).catch((e: unknown) => {
      console.error(`[container] inactivity timeout not set: ${messageOf(e)}`);
    });
    const failure = await this.waitReady();
    const ms = Date.now() - begun;
    const record: BootRecord = { at: new Date().toISOString(), ms, outcome: failure ? 'failed' : 'ready', ...(failure ? { detail: failure } : {}) };
    await this.ctx.storage.put(LAST_BOOT_KEY, record);
    if (failure) {
      console.error(`[cold] durable boot failed ms=${ms}: ${failure}`);
      throw new Error(failure);
    }
    console.log(`[cold] durable boot ms=${ms} (${CONTAINER_INSTANCE})`);
    this.#coldMs = ms;
    // Armed here as well as when a request finishes, so a container never runs without an
    // alarm that will stop it.
    void this.arm(Date.now() + SLEEP_AFTER_MS);
  }

  /** Null when READY_PATH answers through vite; otherwise why not, with the container gone. */
  private async waitReady(): Promise<string | null> {
    const container = this.container;
    const port = container.getTcpPort(CONTAINER_PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = 'no answer';
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch(`http://container${READY_PATH}`, { signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) });
        await res.body?.cancel();
        // Vite answers before the bridge does, and proxies a bridge it cannot reach as a 5xx.
        if (res.ok) return null;
        last = `HTTP ${res.status}`;
      } catch (e) {
        last = messageOf(e);
      }
      if (!container.running) {
        const why = await settledWithin(this.exitOf(container), 1_000);
        if (why !== undefined) return `stopped before it was ready: ${why}`;
      }
      await sleep(READY_POLL_MS);
    }
    await container.destroy().catch(() => undefined);
    return `not ready after ${READY_TIMEOUT_MS} ms: ${last}`;
  }

  private async forward(request: Request, env: Record<string, string>): Promise<Response> {
    const url = request.url.replace('https:', 'http:');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.container.getTcpPort(CONTAINER_PORT).fetch(url, request);
      } catch (e) {
        if (!mayRetry(request.method, attempt)) throw e;
        await sleep(500);
        await this.ensureRunning(env);
      }
    }
  }

  /** Settle the request when its LAST byte leaves (an SSE stream is one long request), with
   *  no buffering: the identity stream forwards chunks as they arrive. */
  private trackBody(response: Response, settle: () => void): Response {
    const { readable, writable } = new IdentityTransformStream();
    response.body!.pipeTo(writable).then(settle, settle);
    return new Response(readable, response);
  }

  /** Hold both ends of a WebSocket (vite HMR) so it counts in flight while open. */
  private proxySocket(response: Response, settle: () => void): Response {
    const upstream = response.webSocket!;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    upstream.accept();
    server.accept();
    // 1005 and 1006 are reserved and may not be sent in a close frame.
    const code = (c: number) => (c === 1005 || c === 1006 ? 1000 : c);
    const pipe = (from: WebSocket, to: WebSocket) => {
      from.addEventListener('message', (event) => {
        try {
          to.send(event.data);
        } catch {
          from.close(1011, 'the other end of the socket is gone');
        }
      });
      from.addEventListener('close', (event) => {
        settle();
        try {
          to.close(code(event.code), event.reason);
        } catch {
          // Already closed from the other side.
        }
      });
      from.addEventListener('error', () => {
        settle();
        try {
          to.close(1011, 'socket error');
        } catch {
          // Already closed.
        }
      });
    };
    pipe(server, upstream);
    pipe(upstream, server);
    return new Response(null, { status: response.status, headers: response.headers, webSocket: client });
  }

  private finished(): void {
    this.#inflight = Math.max(0, this.#inflight - 1);
    if (this.#inflight > 0) return;
    const now = Date.now();
    this.#lastActivity = now;
    if (!this.ctx.container?.running) return;
    const at = rearmAt({ now, scheduled: this.#alarmAt, sleepAfterMs: SLEEP_AFTER_MS });
    if (at !== null) void this.arm(at);
  }

  private async arm(at: number): Promise<void> {
    this.#alarmAt = at;
    try {
      await this.ctx.storage.setAlarm(at);
    } catch (e) {
      this.#alarmAt = null;
      console.error(`[container] alarm not armed: ${messageOf(e)}`);
    }
  }

  /** SIGTERM, then destroy if it lingers. Single-flight: a request arriving mid-stop waits. */
  private stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const stopping = (async () => {
      const container = this.container;
      if (container.running) container.signal(SIGTERM);
      const exited = await settledWithin(this.exitOf(container), STOP_GRACE_MS);
      if (exited === undefined && container.running) await container.destroy();
      console.log('[container] stopped for idleness');
    })().finally(() => {
      if (this.#stopping === stopping) this.#stopping = null;
    });
    this.#stopping = stopping;
    return stopping;
  }

  private exitOf(container: Container): Promise<string> {
    if (!this.#exit) {
      try {
        this.#exit = container.monitor().then(
          () => 'exited cleanly',
          (e: unknown) => messageOf(e),
        );
      } catch (e) {
        this.#exit = Promise.resolve(messageOf(e));
      }
    }
    return this.#exit;
  }
}

/** The promise's value if it settles within `ms`, else undefined, with the timer cleared. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
