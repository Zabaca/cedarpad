import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realAuthGate from './auth-gate.ts';
import * as realCanvases from '../web-poc/lib/db/queries/canvases.ts';
import * as realWorkspaces from '../web-poc/lib/db/queries/workspaces.ts';
import * as realShareLinks from '../web-poc/lib/db/queries/share-links.ts';
import { mintGuestCookie } from './guest-session.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

// The Worker's DISPATCH ORDER is security-load-bearing: `/health` and `/api/buildrev` are
// the only paths served ahead of the edge auth gate, and every container-proxying route —
// now including the Render Pad at `/w/:ws/canvas/:id/pad` (#105) — sits behind it, so an
// unauthenticated request can never cold-boot a container. We exercise the real handler
// with only its INTEGRATION seams stubbed: the sandbox proxy, the Better Auth session
// lookup, and the two D1 ownership lookups. The pure decisions (`decideGate`,
// `decideCanvasRoute`, `parsePadRoute`) run for real.

let session: realAuthGate.ResolvedSession = { user: { id: 'u_1' } };
let workspaceRecord: { id: string } | null = null;
let canvasRecord: { workspaceId: string } | null = null;
let served: SandboxCoords[] = [];
let servedReqs: Array<{ path: string; method: string }> = [];
let servedMcpTokenHeaders: Array<string | null> = [];
let servedGuestCanvasHeaders: Array<string | null> = [];
let servedViewerHeaders: Array<string | null> = [];
let assets: string[] = [];
let mcpTokensByWorkspace: Record<string, Record<string, string>> = {};

mock.module('@cloudflare/sandbox', () => ({
  Sandbox: class {},
  getSandbox: () => ({}),
}));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
    const u = new URL(req.url);
    servedReqs.push({ path: u.pathname + u.search, method: req.method });
    servedMcpTokenHeaders.push(req.headers.get('x-mcp-tokens'));
    servedGuestCanvasHeaders.push(req.headers.get('x-guest-canvas'));
    servedViewerHeaders.push(req.headers.get('x-canvas-viewer'));
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
// Same delegate-and-restore treatment as getWorkspace above: share-links-api.test.ts
// runs the REAL canvases.get against its own in-memory DB later in the same process.
const realGetCanvas = realCanvases.get;
let getCanvasImpl: typeof realGetCanvas = () => Promise.resolve(canvasRecord as never);
mock.module('../web-poc/lib/db/queries/canvases.ts', () => ({
  ...realCanvases,
  get: (...args: Parameters<typeof realGetCanvas>) => getCanvasImpl(...args),
}));
afterAll(() => {
  getCanvasImpl = realGetCanvas;
});
// #220 slice 4: the guest branch's per-request revocation recheck reads the share-links
// query — swappable + restored like the two above (guest-session.test.ts and
// share-links-api.test.ts run the REAL one against their own in-memory DBs).
const realGetActiveShareLink = realShareLinks.getActiveShareLink;
let shareLinkRow: { id: string; canvasId: string } | null = null;
let getActiveShareLinkImpl: typeof realGetActiveShareLink = () => Promise.resolve(shareLinkRow as never);
mock.module('../web-poc/lib/db/queries/share-links.ts', () => ({
  ...realShareLinks,
  getActiveShareLink: (...args: Parameters<typeof realGetActiveShareLink>) => getActiveShareLinkImpl(...args),
}));
afterAll(() => {
  getActiveShareLinkImpl = realGetActiveShareLink;
});
// ADR-0013 train 2 (#176): the chat-send fallthrough reads a workspace's connected
// external-MCP tokens before attaching them to a chat send —
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
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long!!',
  BETTER_AUTH_URL: 'https://poc.cedarpad.com',
  WEB_ORIGIN: 'https://poc.cedarpad.com',
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

// ADR-0022 decision 9: the purge is a door of its own, behind the gate and owner-only.
// Routing proof only — what it reclaims lives in shell.test.ts / record-store.test.ts.
describe('record purge dispatch (#364)', () => {
  test('/api/workspaces/:id/records/purge dispatches to the owner-only purge, never proxied', async () => {
    workspaceRecord = { id: 'ws_abc' }; // visible to the caller, but NOT owned by them
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/api/workspaces/ws_abc/records/purge', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(403); // routed + owner-checked, not 404/405/login
    expect(served).toEqual([]);
  });
});

// PRD #220 slice 2: the share-links API is edge-only and behind the gate. Routing proof
// only — the handler's member checks/mint/revoke behavior lives in share-links-api.test.ts.
describe('share-links dispatch (#220)', () => {
  test('/api/canvases/:id/share-links dispatches to the edge API (unknown canvas ⇒ its 404), never proxied', async () => {
    canvasRecord = null;
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/api/canvases/cv_ghost/share-links', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(404); // the handler's own JSON 404 — routed, not fallthrough-proxied
    expect(((await res.json()) as { error: string }).error).toBe('canvas not found');
    expect(served).toEqual([]);
  });

  test('UNAUTHENTICATED share-links hit gets the login page, never the handler or a container', async () => {
    session = null;
    const res = await GET('/api/canvases/cv_1/share-links');
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(served).toEqual([]);
    session = { user: { id: 'u_1' } };
  });
});

// PRD #220 slice 3: the guest door is pre-gate like /invite — the link id is the credential.
// Full mint behavior lives in guest-session.test.ts; this is the routing proof.
describe('share door dispatch (#220)', () => {
  test('UNAUTHENTICATED /share/<linkId> reaches the door (unknown link ⇒ its own 404), never login, never a container', async () => {
    session = null;
    const res = await GET('/share/sl_unknown');
    expect(res.status).toBe(404); // the door's "link not found" — NOT the login page
    expect(await res.text()).toBe('link not found');
    expect(served).toEqual([]);
    session = { user: { id: 'u_1' } };
  });
});

// PRD #220 slice 4: a guest session (signed cs_guest cookie) passes the gate ONLY inside
// decideGuestGate's per-canvas allowlist, with the link row re-checked every request.
// The pure allow/deny table lives in guest-gate.test.ts; these prove the WIRING — what
// actually reaches serveWorkspace/ASSETS vs. the login page.
describe('guest session gate (#220)', () => {
  const GUEST = { linkId: 'sl_live', canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: false };
  let cookie = '';
  beforeAll(async () => {
    cookie = `cs_guest=${await mintGuestCookie('test-secret-at-least-32-characters-long!!', GUEST)}`;
  });
  const guestFetch = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`https://poc.cedarpad.com${path}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), cookie },
      }),
      env,
    );

  test("a live guest cookie reaches the link's own pad — proxied to the LINK's workspace container, stamped x-guest-canvas", async () => {
    session = null;
    shareLinkRow = { id: 'sl_live', canvasId: 'cv_g' };
    servedGuestCanvasHeaders = [];
    const res = await guestFetch('/w/ws_g/canvas/cv_g/pad', { headers: { 'x-guest-canvas': 'cv_spoofed' } });
    expect(await res.text()).toBe('pad-html');
    expect(served).toEqual([resolve({ id: 'ws_g' })]);
    // The edge OVERWRITES the confinement header — a client-sent value never survives.
    expect(servedGuestCanvasHeaders).toEqual(['cv_g']);
  });

  // A guest has no addressable identity — their per-browser id lives in localStorage and
  // never reaches the edge — so there is nothing truthful to stamp. The guest proxy returns
  // before the authenticated strip block, so a client-sent value would otherwise ride
  // through and let a guest name a MEMBER as the target of a page switch.
  test('a guest cannot forge x-canvas-viewer: the edge deletes it on the way in', async () => {
    session = null;
    shareLinkRow = { id: 'sl_live', canvasId: 'cv_g' };
    servedViewerHeaders = [];
    await guestFetch('/w/ws_g/canvas/cv_g/pad', { headers: { 'x-canvas-viewer': 'u_member' } });
    expect(servedViewerHeaders).toEqual([null]);
  });

  test('the Shell SPA serves in guest mode; canvas API proxies only when addressed to the guest canvas', async () => {
    session = null;
    shareLinkRow = { id: 'sl_live', canvasId: 'cv_g' };
    const spa = await guestFetch('/');
    expect(await spa.text()).toBe('asset');
    // #297: `/api/canvas` went with the old wire. The library READ is the surviving
    // canvas-addressed bridge op a guest may proxy.
    const api = await guestFetch('/api/components', { headers: { 'x-canvas-id': 'cv_g' } });
    expect(await api.text()).toBe('pad-html');
    const wrong = await guestFetch('/api/components', { headers: { 'x-canvas-id': 'cv_other' } });
    expect(wrong.headers.get('content-type') ?? '').toContain('text/html'); // login page
  });

  test('denied surfaces (another pad, the canvas list) get the login page, never a container', async () => {
    session = null;
    shareLinkRow = { id: 'sl_live', canvasId: 'cv_g' };
    served = [];
    for (const p of ['/w/ws_g/canvas/cv_other/pad', '/api/canvases']) {
      const res = await guestFetch(p);
      expect(res.headers.get('content-type') ?? '').toContain('text/html');
    }
    expect(served).toEqual([]);
  });

  test('GET /api/guest-session answers the guest scope for guests and null for members — never proxied', async () => {
    session = null;
    shareLinkRow = { id: 'sl_live', canvasId: 'cv_g' };
    served = [];
    const guestRes = await guestFetch('/api/guest-session');
    // #320: the probe answers the capabilities the gate itself decided from, so the pad
    // can only ever hide affordances the server would refuse — never grant one.
    expect(await guestRes.json()).toEqual({
      canvasId: 'cv_g',
      workspaceId: 'ws_g',
      guestChat: false,
      guestHuddle: false,
      capabilities: { interact: false, editCanvas: false, editSource: false, chat: false, huddle: false },
    });
    session = { user: { id: 'u_1' } };
    const memberRes = await GET('/api/guest-session');
    expect(await memberRes.json()).toBeNull();
    expect(served).toEqual([]);
  });

  test('a REVOKED link kills the session mid-flight: the same cookie now gets the login page', async () => {
    session = null;
    shareLinkRow = null; // revoked/deleted — getActiveShareLink resolves null
    served = [];
    const res = await guestFetch('/w/ws_g/canvas/cv_g/pad');
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(served).toEqual([]);
  });

  test('a tampered cookie is no session at all — login page', async () => {
    session = null;
    shareLinkRow = { id: 'sl_live', canvasId: 'cv_g' };
    served = [];
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/w/ws_g/canvas/cv_g/pad', {
        headers: { cookie: `${cookie}x` },
      }),
      env,
    );
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(served).toEqual([]);
    session = { user: { id: 'u_1' } };
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
  mcpTokensByWorkspace = {};
});

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

  // PRD #354 story 29 (ADR-0022, #363): listing the component library is answered HERE from
  // Records plus the bundled platform manifest. It used to fall through to the container,
  // which can mean cold-booting one — 30–120s and real money — to list a few kilobytes.
  test('GET /api/components is answered at the edge, never proxied to a container', async () => {
    workspaceRecord = { id: 'default' };
    served = [];
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/api/components', { headers: { cookie: 'cs_workspace=default' } }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { components: string[]; details: { name: string; tier: string }[] };
    // The platform tier comes from the manifest bundled with this worker, so the edge can
    // answer it with no filesystem and no container.
    expect(body.components).toContain('MarkdownCard');
    expect(body.details.find((d) => d.name === 'MarkdownCard')?.tier).toBe('base');
    expect(served).toEqual([]);
  });

  // The catch-all fallthrough is what lets the container's vite dev server serve the pad's
  // modules. `/assets/*` is the shell's prefix; vite's are `/src/*`, `/@vite/*`, `/node_modules/*`.
  test('the container’s vite paths still fall through to serveWorkspace', async () => {
    await GET('/src/main.tsx');

    expect(assets).toEqual([]);
    expect(served).toEqual([resolve(DEFAULT_WORKSPACE)]);
  });

  // The Notebook is retired: an old bookmark (the bare surface or any old asset path under it)
  // lands on the canvas, never a 404 and never a container wake.
  test('/notebook and anything under it redirect to the canvas', async () => {
    for (const path of ['/notebook', '/notebook/', '/notebook/assets/main.js']) {
      const res = await GET(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
    expect(assets).toEqual([]);
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

// The Inbox is retired: an old `/inbox` bookmark lands on the canvas, behind the gate.
describe('GET /inbox — the retired Inbox redirects to the canvas', () => {
  test('/inbox 302s to / and never wakes a container', async () => {
    const res = await GET('/inbox');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(served).toEqual([]);
  });

  test('UNAUTHENTICATED ⇒ the login page first', async () => {
    session = null;
    const res = await GET('/inbox');
    expect(res.status).toBe(401);
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

// ADR-0013 train 2 (#176): the same-origin chat send (the pad's <ChatView>) falls through to
// this bottom proxy — it must attach the workspace's connected external-MCP tokens.
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

// x-canvas-viewer decides whose screen select_page may move. The edge is its only writer:
// stamped on a send (and the canvas stream), stripped everywhere else, and a client-sent value
// always loses — a member must not be able to aim an agent at a colleague's view.
describe('the edge owns x-canvas-viewer', () => {
  const SEND = (headers: Record<string, string>) =>
    worker.fetch(new Request('https://poc.cedarpad.com/api/chat/chat_1/send', { method: 'POST', headers }), env);

  test('a CLIENT-SENT viewer never reaches the container; the edge stamps the gated user instead', async () => {
    servedViewerHeaders = [];
    await SEND({ 'x-canvas-viewer': 'u_victim' });
    expect(servedViewerHeaders).toEqual(['u_1']);
  });

  test('a non-send request carries no viewer at all, even when the client supplies one', async () => {
    servedViewerHeaders = [];
    await worker.fetch(
      new Request('https://poc.cedarpad.com/api/chat/chat_1/transcript', { headers: { 'x-canvas-viewer': 'u_victim' } }),
      env,
    );
    expect(servedViewerHeaders).toEqual([null]);
  });
});

// Domain cutover: poc.cedarpad.com 301s to the canonical origin (WEB_ORIGIN), path+query
// intact. Dynamic import — a static one would hoist above the mock.module calls and load
// the real @cloudflare/sandbox.
const { canonicalRedirect } = await import('./index.ts');

describe('canonicalRedirect', () => {
  const CANON = 'https://app.cedarpad.com';

  test('legacy host redirects to the same path+query on the canonical origin', () => {
    const r = canonicalRedirect(new URL('https://poc.cedarpad.com/share/sl_1?x=1'), CANON);
    expect(r?.status).toBe(301);
    expect(r?.headers.get('location')).toBe('https://app.cedarpad.com/share/sl_1?x=1');
  });

  test('canonical host, workers.dev (preview), localhost, and unset origin pass through', () => {
    expect(canonicalRedirect(new URL('https://app.cedarpad.com/x'), CANON)).toBeNull();
    expect(canonicalRedirect(new URL('https://agent-canvas-preview.james-99a.workers.dev/x'), CANON)).toBeNull();
    expect(canonicalRedirect(new URL('http://localhost:8787/x'), CANON)).toBeNull();
    expect(canonicalRedirect(new URL('https://poc.cedarpad.com/x'), undefined)).toBeNull();
  });
});
