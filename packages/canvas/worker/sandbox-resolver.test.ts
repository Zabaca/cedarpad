import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_WORKSPACE,
  LEGACY_R2_PREFIX,
  LEGACY_SANDBOX_ID,
  decideWarm,
  resolve,
} from './sandbox-resolver.ts';

describe('resolve', () => {
  // Table-driven: a workspace record maps to the EXACT expected coordinates.
  const cases: Array<{ name: string; ws: { id: string; legacy?: boolean }; sandboxId: string; r2Prefix: string; canvasWorkspace: string }> = [
    // The default/legacy workspace MUST resolve to the coordinates the single
    // hardcoded container already uses in production — behavior-preserving, and it
    // MUST still run the container with CANVAS_WORKSPACE='default'.
    { name: 'default/legacy → legacy coords', ws: DEFAULT_WORKSPACE, sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' },
    // A NEW workspace uses the derived `workspace-<id>` / `workspaces/<id>/` scheme,
    // and its own id as CANVAS_WORKSPACE so its R2 state is isolated.
    { name: 'new workspace → derived coords', ws: { id: 'ws_abc123' }, sandboxId: 'workspace-ws_abc123', r2Prefix: 'workspaces/ws_abc123/', canvasWorkspace: 'ws_abc123' },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolve(c.ws)).toEqual({ sandboxId: c.sandboxId, r2Prefix: c.r2Prefix, canvasWorkspace: c.canvasWorkspace });
    });
  }

  test('legacy constants match the default workspace resolution', () => {
    expect(resolve(DEFAULT_WORKSPACE)).toEqual({ sandboxId: LEGACY_SANDBOX_ID, r2Prefix: LEGACY_R2_PREFIX, canvasWorkspace: 'default' });
  });
});

describe('decideWarm — warm-vs-cold path selection (matches today)', () => {
  // Real app responses are served as-is; only the sandbox proxy's not-ready
  // signals fall through to a cold start.
  const serve = (status: number, body = '') => expect(decideWarm(status, () => body)).toBe('serve');
  const cold = (status: number, body = '') => expect(decideWarm(status, () => body)).toBe('cold-start');

  test('2xx/3xx app responses are served', () => {
    serve(200);
    serve(302);
  });

  test('a real 4xx/5xx app response (e.g. a failed login) is served, not re-proxied', () => {
    serve(401, 'invalid credentials');
    serve(404, 'not found');
    serve(500, 'app crashed');
  });

  test('410 (container stopped/gone) triggers a cold start', () => {
    cold(410);
  });

  test('sandbox not-ready error bodies trigger a cold start', () => {
    cold(404, '{"code":"INVALID_TOKEN"}');
    cold(502, 'port not exposed');
  });

  test('body is only read for 4xx/5xx (never for a 2xx/3xx fast path)', () => {
    let read = 0;
    decideWarm(200, () => {
      read++;
      return '';
    });
    expect(read).toBe(0);
  });
});
