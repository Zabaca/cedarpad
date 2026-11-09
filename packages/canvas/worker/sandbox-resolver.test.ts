import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_WORKSPACE,
  LEGACY_R2_PREFIX,
  LEGACY_SANDBOX_ID,
  localBridgeOrigin,
  resolve,
  sseRetryResponse,
  urlOnOrigin,
  wantsEventStream,
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

describe('SSE cold-boot fallback — keep the browser reconnecting', () => {
  // An EventSource treats any non-200 / non-`text/event-stream` response as a
  // PERMANENT failure (no auto-reconnect). During a cold boot the worker used to
  // answer stream reconnects with a 500 HTML page, killing every open tab's canvas
  // sync until a manual refresh.

  test('wantsEventStream recognizes an EventSource request by its Accept header', () => {
    expect(wantsEventStream('text/event-stream')).toBe(true);
    expect(wantsEventStream('text/html,application/xhtml+xml')).toBe(false);
    expect(wantsEventStream(null)).toBe(false);
  });

  test('the fallback is a valid, immediately-ending event stream with a retry hint', async () => {
    const res = sseRetryResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('retry: 2000\n\n');
  });
});

describe('localBridgeOrigin — the e2e stand-in for a container (#276)', () => {
  // Local dev runs no container: `containers` is dropped from the generated config
  // (server/dev-worker-config.ts), so proxying into the Sandbox DO throws "Containers have
  // not been enabled". The bridge is just a process on a port there, so local dev points the
  // edge straight at it. BOTH belts must hold or there is no stand-in.

  test('a localhost bridge under LOCAL_CONTAINER_SHIM is the proxy target', () => {
    expect(localBridgeOrigin({ LOCAL_CONTAINER_SHIM: '1', LOCAL_BRIDGE_ORIGIN: 'http://localhost:4693' })).toBe(
      'http://localhost:4693',
    );
    expect(localBridgeOrigin({ LOCAL_CONTAINER_SHIM: '1', LOCAL_BRIDGE_ORIGIN: 'http://127.0.0.1:4693' })).toBe(
      'http://127.0.0.1:4693',
    );
  });

  test('without LOCAL_CONTAINER_SHIM there is no stand-in, whatever the origin says', () => {
    expect(localBridgeOrigin({ LOCAL_BRIDGE_ORIGIN: 'http://localhost:4693' })).toBeNull();
    expect(localBridgeOrigin({ LOCAL_CONTAINER_SHIM: '0', LOCAL_BRIDGE_ORIGIN: 'http://localhost:4693' })).toBeNull();
  });

  test('a non-localhost origin is refused even under the shim — it can never reach a real host', () => {
    for (const origin of ['https://app.cedarpad.com', 'http://localhost.evil.com', 'http://10.0.0.1:4693', '']) {
      expect(localBridgeOrigin({ LOCAL_CONTAINER_SHIM: '1', LOCAL_BRIDGE_ORIGIN: origin })).toBeNull();
    }
    expect(localBridgeOrigin({ LOCAL_CONTAINER_SHIM: '1' })).toBeNull();
  });
});

// A request's path is the caller's, and `new URL(path, origin)` reads a path that starts with `//` (or `/\`, which the URL
// parser turns into `//`) as a scheme-relative reference: another host. A signed-in user opening
// `https://app.cedarpad.com//attacker.example/x` would have had the Worker send the Access service token and their cookies
// to attacker.example. `urlOnOrigin` keeps the origin and puts the path after it, whatever the path looks like.
describe('urlOnOrigin: the caller\'s path never changes the host', () => {
  const ORIGIN = 'https://ws.cedarpad.com';
  test('keeps path and query', () => {
    expect(urlOnOrigin('https://app.cedarpad.com/w/default/pad?x=1&y=2', ORIGIN).href).toBe(`${ORIGIN}/w/default/pad?x=1&y=2`);
  });

  test.each([
    ['//attacker.example/x'],
    ['///attacker.example/x'],
    ['/\\attacker.example/x'],
    ['/\\/attacker.example/x'],
    ['/%2F%2Fattacker.example/x'],
    ['/%2f%2fattacker.example/x'],
    ['/%5Cattacker.example/x'],
    ['/%5C%5Cattacker.example/x'],
    ['//attacker.example@ws.cedarpad.com/x'],
    ['//user:pass@attacker.example/x'],
    ['/.//attacker.example/x'],
    ['/..//attacker.example/x'],
    ['//attacker.example?x=1'],
  ])('%s stays on the origin', (path) => {
    const out = urlOnOrigin(`https://app.cedarpad.com${path}`, ORIGIN);
    expect(out.origin).toBe(ORIGIN);
    expect(out.host).toBe('ws.cedarpad.com');
    expect(out.username).toBe('');
    expect(out.href.startsWith(`${ORIGIN}/`)).toBe(true);
  });

  test('a double slash is kept as a path, not dropped', () => {
    expect(urlOnOrigin('https://app.cedarpad.com//api/buildrev', ORIGIN).pathname).toBe('//api/buildrev');
  });

  test('works for the loopback bridge origin too', () => {
    expect(urlOnOrigin('https://app.cedarpad.com//attacker.example/x', 'http://127.0.0.1:4511').host).toBe('127.0.0.1:4511');
  });
});
