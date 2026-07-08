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

const worker = (await import('./index.ts')).default;
const { resolve, DEFAULT_WORKSPACE } = await import('./sandbox-resolver.ts');

const env = {} as Parameters<typeof worker.fetch>[1];
const GET = (path: string) => worker.fetch(new Request(`https://poc.cedarpad.com${path}`), env);

beforeEach(() => {
  session = { user: { id: 'u_1' } };
  workspaceRecord = null;
  canvasRecord = null;
  served = [];
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
