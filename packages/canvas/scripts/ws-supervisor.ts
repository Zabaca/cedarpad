// The self-hosted workspace supervisor: the small control plane that stands in for
// the workspace's CanvasContainer DO when a workspace runs on our own hardware.
//
// It exists for exactly one reason — the guest must hold NO cedarpad credential at
// rest. On Cloudflare the Worker is the sole holder and injects the environment at
// container start (worker/container-env.ts). A guest running a plain systemd unit
// would need those values on disk to start at all, which is the one design in this
// whole move that would make our posture WORSE than the container baseline. So the
// stack does not start at boot: it starts when the Worker pushes its environment,
// and it dies with this process when it stops.
//
// CONTROL PLANE ONLY. It proxies nothing. cloudflared routes `/__boot` and
// `/__status` here and sends every other path straight to vite on VITE_PORT, so
// the chat SSE stream and the canvas sync websocket never traverse this process —
// no upgrade relay, no backpressure to get wrong, and a supervisor restart cannot
// drop a live stream.
//
// ⚠️ THAT IS ABOUT TRAFFIC, NOT ABOUT THE STACK. **vite is this process's CHILD**
// — `spawn('bun', ['run', 'scripts/dev.ts'])` below — so restarting the
// supervisor STOPS THE CANVAS. It does not merely decline to relay it. The stack
// then stays down until the Worker's next request pushes an environment, which is
// the reboot path described next.
//
// The fact was already here, four paragraphs up: "it dies with this process when
// it stops". It was in the paragraph about CREDENTIALS, while the paragraph a
// reader consults when asking "is a restart safe?" answered with the reassuring
// half. On 2026-08-23 a deliberate `apply workspace ws-service` took the dev stack
// down that way: two readers in a row checked the routing claim, found it correct
// — it is — and concluded a restart was nearly free. The line above answers *what
// a restart interrupts*. This one answers *what a restart kills*, which is the
// question actually being asked.
//
// Reboot behaviour is deliberate: after the host restarts, this comes up with no
// environment and refuses to serve until the Worker's next request pushes one.
// That is the same cold path the Cloudflare container already has, except it costs
// a couple of seconds instead of 30-120.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
// The SAME lock the edge uses, not a second implementation of it. boot-lock.ts is
// deliberately free of any `cloudflare:workers` import so it runs off the edge
// runtime, and it already carries the three properties the 2026-08-13 livelock paid
// for: concurrent callers await one boot, a boot outlives the caller that asked for
// it, and a failed boot is not retried immediately. boot-lock.test.ts holds that shape.
import { BootLock } from '../worker/boot-lock.ts';

const PORT = Number(process.env.WS_SUPERVISOR_PORT ?? 4599);
const VITE_PORT = Number(process.env.WS_VITE_PORT ?? 4510);
const CWD = process.env.WS_CANVAS_CWD ?? '/app/agent-canvas/packages/canvas';
// Bearer the Worker presents. Cloudflare Access already gates the hostname with a
// service token, so this is the second belt: Access is enforced at the edge, and
// this is enforced by the thing that would actually run the command. The process
// refuses to start without it rather than defaulting to open.
const TOKEN = process.env.WS_SUPERVISOR_TOKEN ?? '';
if (!TOKEN) {
  console.error('[ws] WS_SUPERVISOR_TOKEN is unset — refusing to start');
  process.exit(1);
}

// A cold boot can take a while: vite pre-bundles tldraw, which is large. The retired
// Sandbox path waited 120s for the same step, a number itself raised from 40s after
// short timeouts killed healthy-but-slow boots and left an orphaned bridge holding the
// port. Here node_modules and the
// `.vite` cache are persistent, so only the FIRST boot is slow — but the first boot
// is the one that must not be killed.
const BOOT_TIMEOUT_MS = 120_000;

let child: ReturnType<typeof spawn> | null = null;
let startedAt = 0;
// One boot at a time, with a cooldown after a failure. The container learned this the
// expensive way (incident 2026-08-13: 223 boot attempts in 131s, each canceling the
// last) and `BootLock` is the fix that came out of it — reused here rather than
// rewritten, because a second implementation is a second thing to get wrong.
const bootLock = new BootLock();

const running = () => child !== null && child.exitCode === null;

/** Is vite actually listening? The only honest readiness signal — the child being
 *  alive says nothing about whether it bound the port. */
async function portUp(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${VITE_PORT}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portUp()) return true;
    if (!running()) return false; // died on the way up — fail now, not at the deadline
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Write the pushed environment to the file bun auto-loads, then start the stack.
 *  A FILE, not process env, for the reason the retired Sandbox path wrote one:
 *  setEnvVars proved racy across recycles and the bridge intermittently came up with
 *  no R2 credentials and silently fell back to local disk. Written only before a
 *  fresh start, never under a running bridge. */
function start(env: Record<string, string>): void {
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v ?? ''}`)
    .join('\n');
  writeFileSync(`${CWD}/.env`, body + '\n', { mode: 0o600 });

  child = spawn('bun', ['run', 'scripts/dev.ts'], {
    cwd: CWD,
    stdio: ['ignore', 'inherit', 'inherit'],
    // IS_SANDBOX is what makes dev.ts skip `--watch` on the bridge and skip spawning
    // a local edge Worker — in front of this guest the real edge is the deployed one.
    env: { ...process.env, ...env, IS_SANDBOX: '1' },
  });
  startedAt = Date.now();
  child.on('exit', (code, signal) => {
    console.error(`[ws] dev stack exited code=${code} signal=${signal}`);
    child = null;
  });
}

function stop(): void {
  child?.kill('SIGTERM');
  child = null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/__status') {
      return json({ running: running(), up: await portUp(), uptimeMs: startedAt ? Date.now() - startedAt : 0 });
    }

    if (url.pathname === '/__boot' && req.method === 'POST') {
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401);

      // Already serving — the Worker re-pushes on every cold path, and re-writing
      // .env under a live bridge would restart it mid-session.
      if (running() && (await portUp())) return json({ ok: true, already: true });

      const env = (await req.json().catch(() => null)) as Record<string, string> | null;
      if (!env || typeof env !== 'object') return json({ error: 'body must be a JSON object of env vars' }, 400);

      // Concurrent callers join this same boot instead of racing a second dev.ts at
      // the same port, and a failed boot holds off retries for the lock's cooldown —
      // which is the property that matters here, because the pad's own heartbeats
      // (/api/alive, the chat stream, transcript polls) will re-fire immediately.
      try {
        await bootLock.run(async () => {
          if (running()) stop(); // stale child holding the port
          start(env);
          if (!(await waitForPort(BOOT_TIMEOUT_MS))) {
            stop();
            throw new Error(`vite did not bind ${VITE_PORT} within ${BOOT_TIMEOUT_MS}ms`);
          }
        });
        return json({ ok: true, bootMs: Date.now() - startedAt });
      } catch (e) {
        return json({ error: String((e as Error)?.message ?? e) }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },
});

console.log(`[ws] supervisor listening on :${PORT} (vite :${VITE_PORT}, cwd ${CWD})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
}
