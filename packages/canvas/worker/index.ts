import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { authenticate, decideGate, handleAuth } from './auth-gate.ts';
import { DEFAULT_WORKSPACE, resolve } from './sandbox-resolver.ts';
import { sandboxFor, serveWorkspace } from './sandbox-runtime.ts';
import { handleWorkspacesApi, renderLogin, renderShell } from './shell.ts';
import {
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_COOKIE,
  decideWorkspaceRoute,
  parseWorkspaceRoute,
  readWorkspaceCookie,
} from './shell-routing.ts';

// One container = one workspace = one canvas (v1). The Worker is the proxy into the
// in-container vite dev server, which serves the app and forwards /api/* to the bridge.
// Edge Better Auth (ADR-0007, #45) is the SOLE gate — the legacy `cs_gate` shared-secret
// cookie was removed in the #47 cutover. Same preview-proxy path the
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    // Edge auth (ADR-0007, slice #45) — the SOLE gate now that cs_gate is gone. Better
    // Auth's endpoints are served AT THE EDGE so login/session happen here without ever
    // proxying to a container; every other route must carry a valid session.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuth(request, env);
    }
    // Verify the session and decide the gate BEFORE the resolver/proxy below — an
    // unauthenticated request never reaches serveWorkspace, so it never reaches the
    // container. Notebook's /v1/* verifies the SAME Better Auth session (same Turso,
    // same secret, same cookie) in-container, so one auth system spans the platform.
    const session = await authenticate(request, env);
    const gate = decideGate(url.pathname, session);
    if (gate.decision === 'deny' || !gate.user) {
      // Sole-gate deny: serve the edge Better Auth login (#47 cutover) so an
      // unauthenticated user can sign in — never the deleted cs_gate `?key=` page,
      // and never the container.
      return renderLogin();
    }
    const user = gate.user;

    // Edge Shell (ADR-0007, #46). The launcher + its registry API are served HERE — no
    // container is proxied to for either — so listing/creating a workspace never wakes
    // one. Only opening a workspace (/w/:id) routes to a container.

    // Registry API the launcher calls (owner-scoped list/create).
    if (url.pathname === '/api/workspaces') return handleWorkspacesApi(request, env, user);

    // /w/:workspaceId — the app-surface URL. Enforce ownership via the registry (the
    // `default` id is the legacy prod workspace and needs no row), then pin the
    // selection in a cookie and land on the canvas. An unknown/non-owned id is 404 —
    // never proxied. The cookie carries the selection because the canvas frontend loads
    // absolute-path assets (/src, /api) that can't live under a /w/:id prefix.
    const route = parseWorkspaceRoute(url.pathname);
    if (route) {
      const record =
        route.workspaceId === DEFAULT_WORKSPACE_ID
          ? null
          : await getWorkspace(createDbForWorker(env as unknown as Bindings), route.workspaceId, user.id);
      if (decideWorkspaceRoute(route.workspaceId, record).decision === 'not-found') {
        return new Response('workspace not found', { status: 404 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          'set-cookie': `${WORKSPACE_COOKIE}=${route.workspaceId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          location: '/',
        },
      });
    }

    // Which workspace to serve: the cookie set by /w/:id above (ownership already
    // checked at set-time), defaulting to the legacy workspace when unset — so direct
    // asset/API hits with no selection behave exactly as today.
    const selected = readWorkspaceCookie(request.headers.get('cookie'));

    // The launcher is the root when no workspace is selected yet — instant, no boot.
    if (url.pathname === '/' && !selected) return renderShell();

    const workspace =
      !selected || selected === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE : { id: selected };
    const coords = resolve(workspace);

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
