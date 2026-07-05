import { getSandbox, Sandbox as BaseSandbox } from '@cloudflare/sandbox';

// One container = one workspace = one canvas (v1). The Worker is the gate (shared
// secret cookie) and the proxy into the in-container vite dev server, which
// serves the app and forwards /api/* to the bridge. Same preview-proxy path the
// SSE spike proved streams unbuffered, so the canvas SSE stream works as-is.
export class Sandbox extends BaseSandbox {
  // Sleep after idle (state survives in R2). The client idle gate (src/idle.ts) closes
  // both SSE streams after ~2m of no user activity (pointer/keyboard), so an open-but-idle
  // tab no longer pins the container via the 15s ping — this 5m window is the remaining
  // sleep delay once the streams go quiet (total idle-to-sleep ~7m).
  sleepAfter = '5m';
}

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  GATE_SECRET: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  // web-poc (mounted in the bridge, served in-process): remote Turso + auth +
  // embeddings. Secrets (TURSO_*, VOYAGE_API_KEY, BETTER_AUTH_SECRET) come from
  // workerSecrets; the two origins are plain vars in wrangler.jsonc.
  TURSO_URL?: string;
  TURSO_KEY?: string;
  VOYAGE_API_KEY?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  WEB_ORIGIN?: string;
}

const SANDBOX_ID = 'canvas';
const VITE_PORT = 4510;
const PREVIEW_TOKEN = 'canvasproxy';
// The image is the whole workspace at /app/agent-canvas (root context); the canvas
// package — and its scripts/bridge/vite, plus the in-tree web-poc at
// packages/canvas/web-poc — live under packages/canvas.
const START = 'bash -lc "cd /app/agent-canvas/packages/canvas && exec bun run scripts/container-start.ts"';

const SIGN_IN = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>agent-canvas</title><body style="font:16px system-ui;display:grid;place-content:center;height:100vh;margin:0;background:#0b0b0c;color:#e7e7ea">
<div style="text-align:center"><h1 style="font-weight:600">agent-canvas</h1>
<p style="opacity:.7">Locked. Open this URL with <code>?key=…</code> to sign in.</p></div>`;

// Container env injected at process spawn (PRD: ANTHROPIC_API_KEY intentionally
// absent so it can't override the OAuth token).
const containerEnv = (env: Env): Record<string, string> => ({
  R2_BUCKET: env.R2_BUCKET,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT: env.R2_ENDPOINT,
  CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
  CANVAS_WORKSPACE: 'default',
  // web-poc mounted in the bridge: a real remote TURSO_URL makes it use Turso (not
  // the dev libSQL file); the origins line Better Auth up with poc.cedarpad.com.
  TURSO_URL: env.TURSO_URL ?? '',
  TURSO_KEY: env.TURSO_KEY ?? '',
  VOYAGE_API_KEY: env.VOYAGE_API_KEY ?? '',
  BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? '',
  BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? '',
  WEB_ORIGIN: env.WEB_ORIGIN ?? '',
});

// Start (or recover) the dev stack and wait for vite. Mirrors the spike's warm/
// stale handling: try the running process, else start fresh; on a cold boot give
// vite + bridge time to come up (node_modules is image-resident, so no install).
// Write the creds to .env in the container so bun auto-loads them for the bridge
// and every child. setEnvVars / ProcessOptions.envVars proved racy across recycles
// (the bridge intermittently came up with no R2 creds and silently used local-fs);
// a file bun reads at startup is deterministic. Only called before a FRESH start —
// never while the bridge runs, so `bun --watch` can't restart-loop on .env churn.
async function writeEnvFile(sandbox: ReturnType<typeof getSandbox>, ev: Record<string, string>): Promise<void> {
  const body =
    Object.entries(ev)
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join('\n') + '\n';
  // Written into the canvas package (the bridge's cwd) so bun auto-loads it for the
  // bridge and every child — including web-poc's mounted app (Turso/auth secrets).
  await sandbox.writeFile('/app/agent-canvas/packages/canvas/.env', body).catch(() => {});
}

async function ensureStack(sandbox: ReturnType<typeof getSandbox>, env: Env): Promise<void> {
  const ev = containerEnv(env);
  await sandbox.setEnvVars(ev).catch(() => {}); // kept as a secondary path
  const opts = { processId: 'canvas', envVars: ev } as const;
  let proc = await sandbox.getProcess('canvas').catch(() => null);
  if (!proc) {
    await writeEnvFile(sandbox, ev); // creds in place BEFORE the bridge starts
    proc = await sandbox.startProcess(START, opts).catch(() => null);
  }
  // Generous first wait: a cold vite boot (esp. the first pull of a new image)
  // can take tens of seconds; a short timeout would kill a healthy-but-slow boot
  // and restart it pointlessly.
  const up = proc
    ? await proc.waitForPort(VITE_PORT, { timeout: 40000 }).then(() => true).catch(() => false)
    : false;
  if (up) return;
  await sandbox.killProcess('canvas').catch(() => {});
  await writeEnvFile(sandbox, ev);
  const fresh = await sandbox.startProcess(START, opts);
  await fresh.waitForPort(VITE_PORT, { timeout: 60000 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    const secret = env.GATE_SECRET;
    const cookies = (request.headers.get('cookie') ?? '').split(/;\s*/);
    const gated = !!secret && cookies.includes(`cs_gate=${secret}`);
    if (!gated) {
      if (secret && url.searchParams.get('key') === secret) {
        // Set the gate cookie and strip ?key from the URL.
        return new Response(null, {
          status: 302,
          headers: {
            'set-cookie': `cs_gate=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
            location: url.pathname,
          },
        });
      }
      return new Response(SIGN_IN, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Force the container to recycle so a freshly deployed image takes effect (CF
    // keeps the in-use instance on the old image until it idle-sleeps). The next
    // request cold-boots the new image; canvas-state restores from R2.
    if (url.pathname === '/__recycle') {
      const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, { normalizeId: true });
      const r = await sandbox.stop().then(() => 'stopped').catch((e) => String(e));
      return Response.json({ recycle: r });
    }

    // Container stdout (the [boot] phase lines + vite/bridge startup) is NOT in
    // Workers Observability yet (CF gap), so surface getProcessLogs directly. Gated.
    if (url.pathname === '/__bootlog') {
      const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, { normalizeId: true });
      const r: unknown = await sandbox.getProcessLogs('canvas').catch((e) => ({ error: String(e) }));
      const body =
        typeof r === 'string'
          ? r
          : [(r as { stdout?: string }).stdout, (r as { stderr?: string }).stderr].filter(Boolean).join('\n') ||
            JSON.stringify(r, null, 2);
      return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, { normalizeId: true });
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
      const res = await proxy(sandbox, request);
      // Return REAL app responses as-is — any status vite or the bridge produced,
      // including 401/403/404/5xx (a failed login is a legit 401, not a cold start).
      // Only the SANDBOX PROXY's not-ready signals fall through to the cold start:
      //   - 410: container stopped/gone (returning it left the site stuck 410).
      //   - 404/5xx whose body is the sandbox {"code":"INVALID_TOKEN"} / "port not
      //     exposed" error — a never-warmed or recycled container.
      // Treating every app 4xx/5xx as not-ready re-proxied each one and turned
      // failed POSTs into used-body 500s. (#preview)
      if (res.status !== 410) {
        if (res.status < 400) return res;
        const peek = await res.clone().text().catch(() => '');
        if (!/INVALID_TOKEN|port not exposed/.test(peek)) return res;
      }
    } catch {
      /* container unreachable — fall through to the cold path */
    }
    // Cold path: bring the stack up, (re)expose the port, retry once (with the clone).
    try {
      await ensureStack(sandbox, env);
      await sandbox.exposePort(VITE_PORT, { hostname: 'localhost', token: PREVIEW_TOKEN });
      return await proxy(sandbox, retryReq);
    } catch (e: unknown) {
      return new Response('canvas error:\n' + String((e as Error)?.stack ?? e), { status: 500 });
    }
  },
};

// Forward a request into the container's vite dev server (which proxies /api -> the
// bridge) and stream the response back. The one round-trip that's actually needed.
function proxy(sandbox: ReturnType<typeof getSandbox>, request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('x-sandbox-preview-proxy', '1');
  headers.set('x-sandbox-preview-port', String(VITE_PORT));
  headers.set('x-sandbox-preview-token', PREVIEW_TOKEN);
  headers.set('x-sandbox-preview-sandbox-id', SANDBOX_ID);
  return sandbox.fetch(new Request(request, { headers }));
}
