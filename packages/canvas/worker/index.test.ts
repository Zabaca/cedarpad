import { beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realAuthGate from './auth-gate.ts';
import * as realCanvases from '../web-poc/lib/db/queries/canvases.ts';
import * as realWorkspaces from '../web-poc/lib/db/queries/workspaces.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

// The Worker's DISPATCH ORDER is security-load-bearing: `/health` and `/api/buildrev` are
// the only paths served ahead of the edge auth gate, and every container-proxying route —
// now including the Render Pad at `/w/:ws/canvas/:id/pad` (#105) — sits behind it, so an
// unauthenticated request can never cold-boot a container. We exercise the real handler
// with only its INTEGRATION seams stubbed: the sandbox proxy, the Better Auth session
// lookup, and the two Turso ownership lookups. The pure decisions (`decideGate`,
// `decideCanvasRoute`, `parsePadRoute`) run for real.

let session: realAuthGate.ResolvedSession = { user: { id: 'u_1' } };
let workspaceRecord: { id: string } | null = null;
let canvasRecord: { workspaceId: string } | null = null;
let served: SandboxCoords[] = [];
let servedReqs: Array<{ path: string; method: string }> = [];
let assets: string[] = [];
let inboxCalls: Array<{ id?: string; action?: string }> = [];
let conv: ConversationRow | null = null;

mock.module('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
    const u = new URL(req.url);
    servedReqs.push({ path: u.pathname + u.search, method: req.method });
    return new Response('pad-html');
  },
  sandboxFor: () => ({}),
  devAgentSandbox: () => ({}),
}));
mock.module('./auth-gate.ts', () => ({
  ...realAuthGate,
  authenticate: () => Promise.resolve(session),
}));
mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('../web-poc/lib/db/queries/workspaces.ts', () => ({
  ...realWorkspaces,
  getWorkspace: () => Promise.resolve(workspaceRecord),
}));
mock.module('../web-poc/lib/db/queries/canvases.ts', () => ({
  ...realCanvases,
  get: () => Promise.resolve(canvasRecord),
}));
// The edge Inbox LIST/detail API is out of scope for this slice — stub it so we can assert the
// Worker still ROUTES `/api/inbox*` to it (unchanged) without exercising Turso/R2.
mock.module('./inbox.ts', () => ({
  handleInboxApi: (_req: Request, _env: unknown, _user: unknown, id?: string, action?: string) => {
    inboxCalls.push({ id, action });
    return new Response('inbox-api');
  },
}));
// The #122 chat proxy (`./inbox-bridge.ts`) is kept REAL — it's what this slice adds — so its
// ownership check + `conv.workspaceId → coords` resolution run for real against a stubbed
// Conversation lookup and the stubbed serveWorkspace above.
mock.module('../web-poc/lib/db/queries/conversations.ts', () => ({
  get: () => Promise.resolve(conv),
}));

const worker = (await import('./index.ts')).default;
const { resolve, DEFAULT_WORKSPACE } = await import('./sandbox-resolver.ts');

// The Workers static-assets binding, recorded by file path so we can assert WHICH file
// the Shell SPA routes serve — and, crucially, that they never touch `serveWorkspace`.
//
// This models real Workers static-assets `html_handling` ("auto-trailing-slash", the
// default): an explicit `/index.html` request gets 307'd to its canonical `/`, same as a
// real deploy — a naive always-200 stub let a redirect loop reach production undetected
// (an authenticated `/` asking ASSETS for `/index.html` got that 307 back and returned it
// verbatim, so the browser followed it to `/`, which asked for `/index.html` again, forever).
const env = {
  ASSETS: {
    fetch: (req: Request) => {
      const path = new URL(req.url).pathname;
      assets.push(path);
      if (path === '/index.html') return new Response(null, { status: 307, headers: { location: '/' } });
      return new Response('asset');
    },
  },
} as unknown as Parameters<typeof worker.fetch>[1];
const GET = (path: string) => worker.fetch(new Request(`https://poc.cedarpad.com${path}`), env);

describe('POST /api/jobs/dev-agent/run — manual Jobs trigger', () => {
  test('accepts (202) and dispatches the run via waitUntil, without the DEV_AGENT_ENABLED gate', async () => {
    let waited = false;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waited = true;
        void (p as Promise<unknown>).catch(() => {}); // the mocked sandbox rejects; swallow it
      },
    } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/api/jobs/dev-agent/run', { method: 'POST' }),
      env, // no DEV_AGENT_ENABLED set — a manual trigger runs anyway
      ctx,
    );
    expect(res.status).toBe(202);
    expect(waited).toBe(true);
  });

  test('rejects a non-POST (405)', async () => {
    const res = await GET('/api/jobs/dev-agent/run');
    expect(res.status).toBe(405);
  });
});

beforeEach(() => {
  session = { user: { id: 'u_1' } };
  workspaceRecord = null;
  canvasRecord = null;
  served = [];
  servedReqs = [];
  assets = [];
  inboxCalls = [];
  conv = null;
});

const convRow = (o: Partial<ConversationRow>): ConversationRow =>
  ({
    id: o.id ?? 'conv_1',
    sessionId: 'sess_1',
    status: 'open',
    waitingOn: 'human',
    unread: false,
    lastActivity: new Date(0),
    ownerRef: null,
    workspaceId: o.workspaceId ?? 'default',
    userId: o.userId ?? 'u_1',
    summary: null,
    lastMessagePreview: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as ConversationRow;

// THE invariant of PRD #103: browsing the Shell must never wake (or bill) a container.
// The whole point of the pad iframe is that mounting it is the ONLY thing that does.
describe('GET / — the Shell SPA, served from ASSETS without waking the container', () => {
  test('an authenticated `/` serves the shell build and NEVER calls serveWorkspace', async () => {
    const res = await GET('/');

    expect(res.status).toBe(200);
    expect(assets).toEqual(['/']);
    expect(served).toEqual([]);
  });

  test('a workspace selection does not change that — `/` is the shell, not the container', async () => {
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/', { headers: { cookie: 'cs_workspace=ws_abc' } }),
      env,
    );

    expect(res.status).toBe(200);
    expect(assets).toEqual(['/']);
    expect(served).toEqual([]);
  });

  // Regression: `/` MUST ask ASSETS for '/' itself, never the explicit '/index.html' path.
  // Workers static-assets' default html_handling 307s that explicit filename to '/', and a
  // handler that just returns whatever ASSETS gives back turns that into an infinite
  // redirect loop in a real browser (this shipped to prod once — ERR_TOO_MANY_REDIRECTS).
  test('`/` never asks ASSETS for the explicit /index.html path (the redirect-loop regression)', async () => {
    const res = await GET('/');

    expect(assets).not.toContain('/index.html');
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  test('the shell’s built assets come from ASSETS, unrewritten', async () => {
    await GET('/assets/main-a1b2c3.js');

    expect(assets).toEqual(['/assets/main-a1b2c3.js']);
    expect(served).toEqual([]);
  });

  test('UNAUTHENTICATED `/` is the login page, not the shell', async () => {
    session = null;

    const res = await GET('/');

    expect(res.status).toBe(401);
    expect(assets).toEqual([]);
    expect(served).toEqual([]);
  });

  // The catch-all fallthrough is what lets the container's vite dev server serve the pad's
  // modules. `/assets/*` is the shell's prefix; vite's are `/src/*`, `/@vite/*`, `/node_modules/*`.
  test('the container’s vite paths still fall through to serveWorkspace', async () => {
    await GET('/src/main.tsx');

    expect(assets).toEqual([]);
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
  });

  // Notebook is now a Shell stage (#107), not its own SPA surface — the bare URL bounces
  // to the shell with the stage selected. Its assets still share the shell's ASSETS binding
  // (shell/dist/notebook), so `/notebook/assets/*` must keep resolving as a static asset —
  // that's the #106 regression this guards against.
  test('/notebook and /notebook/ redirect to the shell’s notebook stage', async () => {
    const res = await GET('/notebook');
    const resTrailingSlash = await GET('/notebook/');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?stage=notebook');
    expect(resTrailingSlash.status).toBe(302);
    expect(resTrailingSlash.headers.get('location')).toBe('/?stage=notebook');
    expect(assets).toEqual([]);
    expect(served).toEqual([]);
  });

  test('/notebook/assets/* still resolves as a static asset, not a redirect', async () => {
    const res = await GET('/notebook/assets/main.js');

    expect(res.status).toBe(200);
    expect(assets).toEqual(['/notebook/assets/main.js']);
    expect(served).toEqual([]);
  });
});

describe('GET /w/:ws/canvas/:id/pad — serve the Render Pad in place, no redirect', () => {
  test('an owned canvas is proxied to its workspace container with cs_workspace pinned', async () => {
    workspaceRecord = { id: 'ws_abc' };
    canvasRecord = { workspaceId: 'ws_abc' };

    const res = await GET('/w/ws_abc/canvas/cv_1/pad');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pad-html');
    expect(served).toEqual([resolve({ id: 'ws_abc' })]);
    // The iframe's URL must stay stable — a 302 would replace it with `/`.
    expect(res.headers.get('location')).toBeNull();
    const cookies = res.headers.getSetCookie().join('\n');
    expect(cookies).toContain('cs_workspace=ws_abc');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).not.toContain('cs_canvas');
  });

  test('the legacy `default` workspace + canvas resolve to the legacy container', async () => {
    const res = await GET('/w/default/canvas/default/pad');

    expect(res.status).toBe(200);
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
  });

  test('a canvas that belongs to another workspace ⇒ 404, never proxied', async () => {
    workspaceRecord = { id: 'ws_abc' };
    canvasRecord = { workspaceId: 'ws_other' };

    const res = await GET('/w/ws_abc/canvas/cv_1/pad');

    expect(res.status).toBe(404);
    expect(served).toEqual([]);
  });

  test('an unknown/non-owned workspace ⇒ 404, never proxied', async () => {
    workspaceRecord = null;
    canvasRecord = { workspaceId: 'ws_abc' };

    const res = await GET('/w/ws_abc/canvas/cv_1/pad');

    expect(res.status).toBe(404);
    expect(served).toEqual([]);
  });

  test('UNAUTHENTICATED ⇒ the login page, never the container (no cold boot)', async () => {
    session = null;
    workspaceRecord = { id: 'ws_abc' };
    canvasRecord = { workspaceId: 'ws_abc' };

    const res = await GET('/w/ws_abc/canvas/cv_1/pad');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(served).toEqual([]);
  });
});

// The Inbox is a Shell stage now (#108): the standalone `renderInbox` page is gone. The
// legacy `/inbox` route redirects into the shell; the `/api/inbox*` data API is UNCHANGED.
describe('GET /inbox — redirect to the Shell inbox stage, no standalone page', () => {
  test('/inbox 302s to /?stage=inbox and never wakes a container or renders its own page', async () => {
    const res = await GET('/inbox');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?stage=inbox');
    expect(served).toEqual([]);
    expect(assets).toEqual([]);
    expect(inboxCalls).toEqual([]);
  });

  test('the inbox data API still routes to handleInboxApi (list), no container woken', async () => {
    const res = await GET('/api/inbox?status=open');

    expect(await res.text()).toBe('inbox-api');
    expect(inboxCalls).toEqual([{ id: undefined, action: undefined }]);
    expect(served).toEqual([]);
  });

  test('per-conversation actions still route to handleInboxApi with id + action', async () => {
    await worker.fetch(new Request('https://poc.cedarpad.com/api/inbox/c_1/close', { method: 'POST' }), env);
    await GET('/api/inbox/c_1');

    expect(inboxCalls).toEqual([
      { id: 'c_1', action: 'close' },
      { id: 'c_1', action: undefined },
    ]);
  });

  // REGRESSION: browsing the Inbox list must never wake a runner. The list stays edge-only
  // and never calls serveWorkspace — only opening a Conversation's chat bridge does.
  test('the inbox LIST never calls serveWorkspace (no runner woken by browsing)', async () => {
    await GET('/api/inbox?status=open');

    expect(served).toEqual([]);
  });
});

// The edge chat proxy (ADR-0009, #122). `/inbox/:convId/bridge/*` is a live view of the
// Conversation's OWNING bridge, so it sits BELOW the auth gate: an anon request gets the
// login and never reaches a bridge (never cold-boots a container). The real handler runs
// here (spread above) with only serveWorkspace + conversations.get stubbed.
describe('GET /inbox/:convId/bridge/* — the edge chat proxy, conv → owning bridge, gated', () => {
  test('an owned product-workspace conversation proxies to its container, sub-path unrewritten', async () => {
    conv = convRow({ workspaceId: 'ws_abc', userId: 'u_1' });

    const res = await GET('/inbox/conv_1/bridge/api/chat/stream?canvas=c');

    expect(res.status).toBe(200);
    expect(served).toEqual([resolve({ id: 'ws_abc' })]);
    // The `/inbox/:id/bridge` prefix is stripped; only the bridge sub-path (query preserved)
    // reaches the container — the same unbuffered proxy the pad uses, so SSE streams through.
    expect(servedReqs).toEqual([{ path: '/api/chat/stream?canvas=c', method: 'GET' }]);
  });

  test('a dev-agent conversation resolves to the dev-agent sandbox, not a workspace-<id> container', async () => {
    conv = convRow({ workspaceId: 'dev-agent', userId: 'u_1' });

    await GET('/inbox/conv_1/bridge/api/chat/stream');

    expect(served).toHaveLength(1);
    expect(served[0].sandboxId).toBe('dev-agent');
    // NOT the derived `workspace-dev-agent` — that container holds no bridge session.
    expect(served[0].sandboxId).not.toBe(resolve({ id: 'dev-agent' }).sandboxId);
  });

  test('a POST (send) is forwarded with its method + stripped sub-path to the owning container', async () => {
    conv = convRow({ workspaceId: 'ws_abc', userId: 'u_1' });

    await worker.fetch(
      new Request('https://poc.cedarpad.com/inbox/conv_1/bridge/api/chat/conv_1/send', { method: 'POST', body: '{}' }),
      env,
    );

    expect(served).toEqual([resolve({ id: 'ws_abc' })]);
    expect(servedReqs).toEqual([{ path: '/api/chat/conv_1/send', method: 'POST' }]);
  });

  test('a conversation owned by someone else ⇒ 404, never proxied (no bridge woken)', async () => {
    conv = convRow({ workspaceId: 'ws_abc', userId: 'someone_else' });

    const res = await GET('/inbox/conv_1/bridge/api/chat/stream');

    expect(res.status).toBe(404);
    expect(served).toEqual([]);
  });

  test('UNAUTHENTICATED ⇒ the login page, never the bridge (no container reached)', async () => {
    session = null;
    conv = convRow({ workspaceId: 'ws_abc', userId: 'u_1' });

    const res = await GET('/inbox/conv_1/bridge/api/chat/stream');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(served).toEqual([]);
  });
});

describe('dispatch order regressions', () => {
  // The deep-link must preserve WHICH canvas was asked for. It used to 302 to `/` and let
  // cs_canvas carry the id; with the cookie gone, `/` would serve the DEFAULT canvas.
  test('/w/:ws/canvas/:id (no /pad) 302s to that canvas pad and sets only cs_workspace', async () => {
    workspaceRecord = { id: 'ws_abc' };
    canvasRecord = { workspaceId: 'ws_abc' };

    const res = await GET('/w/ws_abc/canvas/cv_1');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/w/ws_abc/canvas/cv_1/pad');
    const cookies = res.headers.getSetCookie().join('\n');
    expect(cookies).toContain('cs_workspace=ws_abc');
    expect(cookies).not.toContain('cs_canvas');
    expect(served).toEqual([]);
  });

  test('/health is public', async () => {
    session = null;
    const res = await GET('/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('/api/buildrev is public and proxies the default workspace', async () => {
    session = null;
    const res = await GET('/api/buildrev');
    expect(res.status).toBe(200);
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
  });
});
