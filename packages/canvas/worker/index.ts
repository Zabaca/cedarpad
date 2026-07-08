import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { authenticate, decideGate, handleAuth } from './auth-gate.ts';
import { DEFAULT_WORKSPACE, resolve } from './sandbox-resolver.ts';
import { sandboxFor, serveWorkspace } from './sandbox-runtime.ts';

// One container = one workspace = one canvas (v1). The Worker is the gate (shared
// secret cookie) and the proxy into the in-container vite dev server, which
// serves the app and forwards /api/* to the bridge. Same preview-proxy path the
// SSE spike proved streams unbuffered, so the canvas SSE stream works as-is.
export class Sandbox extends BaseSandbox {
  // Sleep after idle (state survives in R2). The client idle gate (src/idle.ts) closes
  // both SSE streams after ~2m of no user activity (pointer/keyboard), so an open-but-idle
  // tab no longer pins the container via the 15s ping — this 5m window is the remaining
  // sleep delay once the streams go quiet (total idle-to-sleep ~7m).
  // Fallback only: the bridge self-exits on idle (server/bridge.ts) since the sandbox
  // won't idle-sleep while an SSE forward is pinned. sleepAfter still covers the
  // never-had-a-client case.
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

const SIGN_IN = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>agent-canvas</title><body style="font:16px system-ui;display:grid;place-content:center;height:100vh;margin:0;background:#0b0b0c;color:#e7e7ea">
<div style="text-align:center"><h1 style="font-weight:600">agent-canvas</h1>
<p style="opacity:.7">Locked. Open this URL with <code>?key=…</code> to sign in.</p></div>`;

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

    // Edge auth (ADR-0007, slice #45), layered on top of cs_gate above. Better Auth's
    // endpoints are served AT THE EDGE so login/session happen here without ever
    // proxying to a container; every other route must carry a valid session.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuth(request, env);
    }
    // Verify the session and decide the gate BEFORE the resolver/proxy below — an
    // unauthenticated request never reaches serveWorkspace, so it never reaches the
    // container. Notebook's /v1/* verifies the SAME Better Auth session (same Turso,
    // same secret, same cookie) in-container, so one auth system spans the platform.
    const session = await authenticate(request, env);
    if (decideGate(url.pathname, session).decision === 'deny') {
      return new Response(SIGN_IN, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // This slice selects a single default workspace; registry-derived, per-URL routing
    // (/w/:workspaceId) lands in a later slice. The default resolves to the legacy
    // coordinates the deployed container already uses, so behavior is unchanged.
    const coords = resolve(DEFAULT_WORKSPACE);

    // Force the container to recycle so a freshly deployed image takes effect (CF
    // keeps the in-use instance on the old image until it idle-sleeps). The next
    // request cold-boots the new image; canvas-state restores from R2.
    if (url.pathname === '/__recycle') {
      const sandbox = sandboxFor(env, coords.sandboxId);
      const r = await sandbox.stop().then(() => 'stopped').catch((e) => String(e));
      return Response.json({ recycle: r });
    }

    // Container stdout (the [boot] phase lines + vite/bridge startup) is NOT in
    // Workers Observability yet (CF gap), so surface getProcessLogs directly. Gated.
    if (url.pathname === '/__bootlog') {
      const sandbox = sandboxFor(env, coords.sandboxId);
      const r: unknown = await sandbox.getProcessLogs('canvas').catch((e) => ({ error: String(e) }));
      const body =
        typeof r === 'string'
          ? r
          : [(r as { stdout?: string }).stdout, (r as { stderr?: string }).stderr].filter(Boolean).join('\n') ||
            JSON.stringify(r, null, 2);
      return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    return serveWorkspace(request, env, coords);
  },
};
