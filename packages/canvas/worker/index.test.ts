import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

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
let servedMcpTokenHeaders: Array<string | null> = [];
let assets: string[] = [];
let inboxCalls: Array<{ id?: string; action?: string }> = [];
let conv: ConversationRow | null = null;
let mcpTokensByWorkspace: Record<string, Record<string, string>> = {};

mock.module('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
    const u = new URL(req.url);
    servedReqs.push({ path: u.pathname + u.search, method: req.method });
    servedMcpTokenHeaders.push(req.headers.get('x-mcp-tokens'));
    return new Response('pad-html');
  },
  sandboxFor: () => ({}),
}));
mock.module('./auth-gate.ts', () => ({
  ...realAuthGate,
  authenticate: () => Promise.resolve(session),
}));
// A minimal chainable query stub: every builder call returns itself and it awaits to
// an empty row set — enough for handlers that only need "no rows found" (e.g. the
// invite accept flow resolving an unknown token to its 404 page).
const emptyQuery: Record<string, unknown> = {};
for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set']) {
  emptyQuery[m] = () => emptyQuery;
}
(emptyQuery as { then: (resolve: (rows: never[]) => void) => void }).then = (resolve) => resolve([]);
mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => emptyQuery }));
// Delegate through a swappable impl and RESTORE after this file: bun's mock.module
// rebinds the module for every later test file in the same process (#170's leak class),
// so a canned getWorkspace here would silently break real-DB tests (e.g.
// invitations.test.ts) that run after this one in a full-suite pass.
// CAPTURE BY VALUE before mock.module below: `realWorkspaces` is a LIVE namespace —
// after the mock installs, `realWorkspaces.getWorkspace` IS the delegating wrapper, and
// restoring from it would make the wrapper call itself (a proper-tail-call infinite
// loop that hangs the whole test process, no stack overflow).
const realGetWorkspace = realWorkspaces.getWorkspace;
let getWorkspaceImpl: typeof realGetWorkspace = () => Promise.resolve(workspaceRecord as never);
mock.module('../web-poc/lib/db/queries/workspaces.ts', () => ({
  ...realWorkspaces,
  getWorkspace: (...args: Parameters<typeof realGetWorkspace>) => getWorkspaceImpl(...args),
}));
afterAll(() => {
  getWorkspaceImpl = realGetWorkspace;
});
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
// ADR-0013 train 2 (#176): both proxy points (this fallthrough and the inbox bridge above)
// read a workspace's connected external-MCP tokens before attaching them to a chat send —
// stubbed by workspaceId so a test can assert connect/no-connect/isolation. See
// mcp-tokens-api.test.ts for the owner-consent API's ownership check.
mock.module('../web-poc/lib/db/queries/mcp-tokens.ts', () => ({
  listTokens: (_db: unknown, workspaceId: string) => Promise.resolve(mcpTokensByWorkspace[workspaceId] ?? {}),
  setToken: () => Promise.resolve(),
  clearToken: () => Promise.resolve(),
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

// #177 dispatch order: OAuth discovery is public at the origin root, and /mcp self-gates
// on its bearer — an unauthenticated request gets the OAuth 401 challenge, never the login
// page, and never touches a container.
describe('inbound MCP dispatch (#177)', () => {
  test('UNAUTHENTICATED discovery routes serve metadata JSON, never the login page', async () => {
    session = null;
    const res = await GET('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('json');
    expect(served).toEqual([]);
  });

  test('UNAUTHENTICATED /mcp answers the OAuth bearer challenge (401 + WWW-Authenticate), never login, never a container', async () => {
    session = null;
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').not.toBe('');
    expect(served).toEqual([]);
  });
});

// #179 dispatch order: /invite/<token> is the one page an invitee can reach with no
// session (the token is the credential) — it must serve the invite flow, never the
// login page, and never touch a container. The owner-side invitations API stays
// behind the gate and its owner-only check.
describe('invitations dispatch (#179)', () => {
  test('UNAUTHENTICATED /invite/<token> reaches the invite flow (unknown token ⇒ its own 404 page), never login, never a container', async () => {
    session = null;
    const res = await GET('/invite/wi_unknown');
    expect(res.status).toBe(404); // the flow's "not valid" page — NOT the 401 login
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(served).toEqual([]);
  });

  test('/api/workspaces/:id/invitations dispatches to the owner-only API behind the gate, never proxied', async () => {
    workspaceRecord = { id: 'ws_abc' }; // a visible record that does NOT carry the caller as owner
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/api/workspaces/ws_abc/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co' }),
      }),
      env,
    );
    expect(res.status).toBe(403); // routed + access-checked (owner-only), not 404/405/login
    expect(served).toEqual([]);
  });
});

describe('POST /api/jobs/dev-agent/run — manual Jobs trigger (ADR-0011: a proxied kick)', () => {
  test('proxies the kick to the warm default container’s bridge and returns its answer through', async () => {
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/api/jobs/dev-agent/run', { method: 'POST' }),
      env, // no DEV_AGENT_ENABLED set — a manual trigger runs anyway
    );
    // The bridge's response ({chatId, joined}) is returned verbatim — here the stub's body.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pad-html');
    // The kick is a chat-turn dispatch on the warm default container — no separate sandbox.
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
    expect(servedReqs).toEqual([{ path: '/api/dev-agent/run', method: 'POST' }]);
  });

  test('rejects a non-POST (405)', async () => {
    const res = await GET('/api/jobs/dev-agent/run');
    expect(res.status).toBe(405);
    expect(served).toEqual([]);
  });
});

describe('scheduled — the cron kicks the same bridge run (ADR-0011)', () => {
  test('an enabled scheduled run proxies the kick to the warm default container', async () => {
    // Await the waitUntil'd work: the kick is multi-hop async now (repo resolution before
    // mint, ADR-0015), so asserting without draining it is a race.
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pending.push((p as Promise<unknown>).catch(() => {})),
    } as unknown as ExecutionContext;
    await worker.scheduled(
      { cron: '0 9 * * *', scheduledTime: 0 } as ScheduledController,
      { ...(env as object), DEV_AGENT_ENABLED: 'true' } as Parameters<typeof worker.fetch>[1],
      ctx,
    );
    await Promise.all(pending);
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
    expect(servedReqs).toEqual([{ path: '/api/dev-agent/run', method: 'POST' }]);
  });

  test('a disabled cron (flag unset) kicks nothing', async () => {
    const ctx = { waitUntil: (p: Promise<unknown>) => void (p as Promise<unknown>).catch(() => {}) } as unknown as ExecutionContext;
    await worker.scheduled({ cron: '0 9 * * *', scheduledTime: 0 } as ScheduledController, env, ctx);
    expect(served).toEqual([]);
  });
});

beforeEach(() => {
  session = { user: { id: 'u_1' } };
  workspaceRecord = null;
  canvasRecord = null;
  served = [];
  servedReqs = [];
  servedMcpTokenHeaders = [];
  assets = [];
  inboxCalls = [];
  conv = null;
  mcpTokensByWorkspace = {};
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

  test('the legacy `default` workspace (with its seeded, access-checked row — #179) + canvas resolve to the legacy container', async () => {
    workspaceRecord = { id: 'default' };
    const res = await GET('/w/default/canvas/default/pad');

    expect(res.status).toBe(200);
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
  });

  test('the `default` workspace WITHOUT a row (non-member) ⇒ 404, never proxied (#179 closes the hole)', async () => {
    workspaceRecord = null;
    const res = await GET('/w/default/canvas/default/pad');

    expect(res.status).toBe(404);
    expect(served).toEqual([]);
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

  test('a dev-agent conversation resumes on the WARM default container (ADR-0010)', async () => {
    // Dev-agent is a Conversation KIND now; the row lives in the workspace it runs in.
    conv = convRow({ workspaceId: 'default', kind: 'dev-agent', userId: 'u_1' });

    await GET('/inbox/conv_1/bridge/api/chat/stream');

    // No routing special-case: a dev-agent row routes like any default-workspace chat.
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
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

// ADR-0013 train 2 (#176): the same-origin chat send (the pad's <ChatView>, not inbox-adopted)
// falls through to this bottom proxy — it must attach the workspace's connected external-MCP
// tokens exactly like the Inbox proxy does, since it's the primary path most chat sends take.
const POST = (path: string) => worker.fetch(new Request(`https://poc.cedarpad.com${path}`, { method: 'POST' }), env);

describe('the same-origin chat send attaches the workspace’s connected MCP tokens (ADR-0013 train 2)', () => {
  test('a connected token attaches x-mcp-tokens to the proxied send', async () => {
    mcpTokensByWorkspace = { default: { ledgerbot: 'tok_default' } };
    await POST('/api/chat/chat_1/send');
    expect(servedMcpTokenHeaders).toEqual([JSON.stringify({ ledgerbot: 'tok_default' })]);
  });

  test('no connected token ⇒ no header at all', async () => {
    await POST('/api/chat/chat_1/send');
    expect(servedMcpTokenHeaders).toEqual([null]);
  });

  test('a non-send request never attaches the header even if the workspace has a token', async () => {
    mcpTokensByWorkspace = { default: { ledgerbot: 'tok_default' } };
    await GET('/api/chat/chat_1/transcript');
    expect(servedMcpTokenHeaders).toEqual([null]);
  });
});
