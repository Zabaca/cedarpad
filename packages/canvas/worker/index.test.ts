import { beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realAuthGate from './auth-gate.ts';
import * as realCanvases from '../web-poc/lib/db/queries/canvases.ts';
import * as realWorkspaces from '../web-poc/lib/db/queries/workspaces.ts';
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
let assets: string[] = [];
let inboxCalls: Array<{ id?: string; action?: string }> = [];

mock.module('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (_req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
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
// The edge Inbox API handler is out of scope for this slice — stub it so we can assert the
// Worker still ROUTES `/api/inbox*` to it (unchanged) without exercising Turso/R2.
mock.module('./inbox.ts', () => ({
  handleInboxApi: (_req: Request, _env: unknown, _user: unknown, id?: string, action?: string) => {
    inboxCalls.push({ id, action });
    return new Response('inbox-api');
  },
}));

const worker = (await import('./index.ts')).default;
const { resolve, DEFAULT_WORKSPACE } = await import('./sandbox-resolver.ts');

// The Workers static-assets binding, recorded by file path so we can assert WHICH file
// the Shell SPA routes serve — and, crucially, that they never touch `serveWorkspace`.
const env = {
  ASSETS: {
    fetch: (req: Request) => {
      assets.push(new URL(req.url).pathname);
      return new Response('asset');
    },
  },
} as unknown as Parameters<typeof worker.fetch>[1];
const GET = (path: string) => worker.fetch(new Request(`https://poc.cedarpad.com${path}`), env);

beforeEach(() => {
  session = { user: { id: 'u_1' } };
  workspaceRecord = null;
  canvasRecord = null;
  served = [];
  assets = [];
  inboxCalls = [];
});

// THE invariant of PRD #103: browsing the Shell must never wake (or bill) a container.
// The whole point of the pad iframe is that mounting it is the ONLY thing that does.
describe('GET / — the Shell SPA, served from ASSETS without waking the container', () => {
  test('an authenticated `/` serves the shell build and NEVER calls serveWorkspace', async () => {
    const res = await GET('/');

    expect(res.status).toBe(200);
    expect(assets).toEqual(['/index.html']);
    expect(served).toEqual([]);
  });

  test('a workspace selection does not change that — `/` is the shell, not the container', async () => {
    const res = await worker.fetch(
      new Request('https://poc.cedarpad.com/', { headers: { cookie: 'cs_workspace=ws_abc' } }),
      env,
    );

    expect(res.status).toBe(200);
    expect(assets).toEqual(['/index.html']);
    expect(served).toEqual([]);
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

  // The Notebook SPA now builds into shell/dist/notebook, so it shares the one ASSETS
  // binding with the shell. Slice #107 re-homes it as a stage; until then /notebook serves.
  test('/notebook still serves its own SPA build, alongside the shell', async () => {
    await GET('/notebook');
    await GET('/notebook/assets/main.js');

    expect(assets).toEqual(['/notebook/index.html', '/notebook/assets/main.js']);
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
