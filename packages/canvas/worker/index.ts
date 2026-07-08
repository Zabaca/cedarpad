import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { get as getCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { buildApp } from '../web-poc/worker/index.ts';
import { authenticate, decideGate, handleAuth } from './auth-gate.ts';
import { dispatchDevAgentRun, runDevAgent } from './dev-agent.ts';
import { DEFAULT_WORKSPACE, resolve } from './sandbox-resolver.ts';
import { devAgentSandbox, sandboxFor, serveWorkspace } from './sandbox-runtime.ts';
import { handleCanvasesApi, handleWorkspacesApi, renderInbox, renderLogin, renderShell } from './shell.ts';
import { handleInboxApi } from './inbox.ts';
import {
  CANVAS_COOKIE,
  DEFAULT_CANVAS_ID,
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_COOKIE,
  decideCanvasRoute,
  decideWorkspaceRoute,
  parseCanvasRoute,
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
  // Workers static-assets binding for the Notebook SPA build (web-poc/dist, PRD #49
  // slice #58). Served under /notebook AFTER the edge session gate — it's app content,
  // so an unauthenticated hit gets the login, never the SPA.
  ASSETS: Fetcher;
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

// Notebook's Hono API (web-poc's `buildApp`), mounted AT THE EDGE (ADR-0007, #56). No
// db is injected, so its `dbMiddleware` builds one per request via
// `createDbForWorker(c.env)` — the workerd-safe `@libsql/client/web` client against
// remote Turso — so Notebook's `/v1/*` runs here without ever waking a container.
// Built once per isolate (route setup is pure); the db is per-request.
const notebookApi = buildApp();

export default {
  // Cron trigger (ADR-0007, PRD #51 slice #63). Off-hours the edge wakes the dev-agent
  // sandbox — a SEPARATE instance on its own sleep schedule — and kicks one run, which
  // then idle-sleeps on its own timer. This path touches ONLY the dev-agent instance:
  // no workspace container is woken or reaped by a scheduled run. `waitUntil` keeps the
  // isolate alive for the async run past the handler return.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchDevAgentRun(event, env, { sandbox: devAgentSandbox, run: runDevAgent }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    // Edge auth (ADR-0007, slice #45) — the SOLE gate now that cs_gate is gone. Better
    // Auth's endpoints are served AT THE EDGE so login/session happen here without ever
    // proxying to a container; every other route must carry a valid session. This branch
    // precedes the Notebook mount below, so `buildApp`'s own `/api/auth/*` mount is never
    // reached — ONE auth path (this `handleAuth`) across the platform.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuth(request, env);
    }

    // Notebook API at the edge (ADR-0007, #56). `/v1/*` is served HERE against remote
    // Turso, so Notebook no longer depends on / wakes the container. It SELF-gates via
    // web-poc's `authMiddleware` (Better Auth session cookie OR `x-api-key`) against the
    // SAME `createAuth` + Turso the edge `/api/auth` path uses — one auth system — so we
    // deliberately route it BEFORE the edge session gate below (which would `renderLogin`
    // HTML and can't honour agent `x-api-key`). Notebook returns its own JSON 401.
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      return notebookApi.fetch(request, env as never);
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

    // Notebook SPA static build (ADR-0007, PRD #49 slice #58). Served HERE, behind the
    // edge session gate above, from the Workers static-assets binding — no container,
    // no dev vite. The SPA is built with base `/notebook/`, so its asset URLs are
    // `/notebook/assets/*`; strip the `/notebook` prefix before the ASSETS lookup (which
    // maps request path → file path in web-poc/dist). `/notebook` (or `/notebook/`) maps
    // to the SPA's index.html. Its client then calls `/v1` + `/api/auth/*` on this same
    // edge origin, already workspace-scoped by the `cs_workspace` cookie (#57).
    if (url.pathname === '/notebook' || url.pathname.startsWith('/notebook/')) {
      const assetPath = url.pathname.slice('/notebook'.length) || '/';
      const assetUrl = new URL(request.url);
      assetUrl.pathname = assetPath;
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Edge Shell (ADR-0007, #46). The launcher + its registry API are served HERE — no
    // container is proxied to for either — so listing/creating a workspace never wakes
    // one. Only opening a workspace (/w/:id) routes to a container.

    // Registry API the launcher calls (owner-scoped list/create).
    if (url.pathname === '/api/workspaces') return handleWorkspacesApi(request, env, user);

    // Canvas registry API (Canvas app index), scoped to the active workspace via the
    // cs_workspace cookie. Served at the edge like /api/workspaces — no container woken.
    if (url.pathname === '/api/canvases') {
      return handleCanvasesApi(request, createDbForWorker(env as unknown as Bindings), user);
    }
    const canvasApiMatch = /^\/api\/canvases\/([^/]+)$/.exec(url.pathname);
    if (canvasApiMatch) {
      return handleCanvasesApi(request, createDbForWorker(env as unknown as Bindings), user, canvasApiMatch[1]);
    }

    // Edge Inbox API (ADR-0007, PRD #50 slice #62), user-scoped. Served HERE against remote
    // Turso + R2: list/detail/close/reopen never wake a container (history reads from the R2
    // transcript while the runner sleeps); only reply forwards into the container (#61).
    const inboxApiMatch = /^\/api\/inbox(?:\/([^/]+)(?:\/(reply|close|reopen))?)?$/.exec(url.pathname);
    if (inboxApiMatch) {
      return handleInboxApi(request, env, user, inboxApiMatch[1], inboxApiMatch[2]);
    }

    // The Inbox surface itself — a self-contained static page (like the Shell launcher),
    // behind the edge session gate above.
    if (url.pathname === '/inbox') return renderInbox();

    // /w/:workspaceId/canvas/:canvasId — the canvas app-surface URL. Selecting it pins
    // BOTH the workspace (cs_workspace, HttpOnly — the proxy routes by it) and the canvas
    // (cs_canvas, NON-HttpOnly — the frontend reads it to stamp x-canvas-id). Validate
    // that the workspace is owned AND the canvas belongs to it, else 404 (never proxied).
    const canvasRoute = parseCanvasRoute(url.pathname);
    if (canvasRoute) {
      const workerDb = createDbForWorker(env as unknown as Bindings);
      const wsRecord =
        canvasRoute.workspaceId === DEFAULT_WORKSPACE_ID
          ? null
          : await getWorkspace(workerDb, canvasRoute.workspaceId, user.id);
      const cvRecord =
        canvasRoute.canvasId === DEFAULT_CANVAS_ID ? null : await getCanvas(workerDb, canvasRoute.canvasId);
      const decision = decideCanvasRoute(canvasRoute.workspaceId, canvasRoute.canvasId, wsRecord, cvRecord);
      if (decision.decision === 'not-found') {
        return new Response('canvas not found', { status: 404 });
      }
      const cookieAttrs = 'Path=/; Secure; SameSite=Lax';
      return new Response(null, {
        status: 302,
        headers: new Headers([
          ['set-cookie', `${WORKSPACE_COOKIE}=${decision.workspaceId}; ${cookieAttrs}; HttpOnly`],
          ['set-cookie', `${CANVAS_COOKIE}=${decision.canvasId}; ${cookieAttrs}`],
          ['location', '/'],
        ]),
      });
    }

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
