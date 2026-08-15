import { afterEach, describe, expect, mock, test } from 'bun:test';
import { guestRequest, parseWorkspaceMap, selfHostedTarget, serveSelfHosted, staysOnContainer } from './self-hosted.ts';
import type { SelfHostedTarget } from './self-hosted.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

const CREDS = {
  WS_SUPERVISOR_TOKEN: 'sup-token',
  CF_ACCESS_CLIENT_ID: 'cid.access',
  CF_ACCESS_CLIENT_SECRET: 'csecret',
};
const MAP = JSON.stringify({ default: 'https://ws.cedarpad.com' });
const COORDS: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };
const TARGET: SelfHostedTarget = {
  origin: 'https://ws.cedarpad.com',
  supervisorToken: 'sup-token',
  accessClientId: 'cid.access',
  accessClientSecret: 'csecret',
};

describe('parseWorkspaceMap', () => {
  test('reads a workspace -> origin map', () => {
    expect(parseWorkspaceMap(MAP)).toEqual({ default: 'https://ws.cedarpad.com' });
  });

  // Failing OPEN is deliberate: an unreadable map must mean "nothing is
  // self-hosted", not "every workspace is down".
  test('malformed JSON yields an empty map rather than throwing', () => {
    expect(parseWorkspaceMap('{not json')).toEqual({});
    expect(parseWorkspaceMap('[1,2]')).toEqual({});
    expect(parseWorkspaceMap(undefined)).toEqual({});
  });

  test('rejects a non-https origin — the Access secret rides these requests', () => {
    expect(parseWorkspaceMap(JSON.stringify({ a: 'http://ws.cedarpad.com' }))).toEqual({});
  });

  test('strips a stray path so it cannot silently prefix every request', () => {
    expect(parseWorkspaceMap(JSON.stringify({ a: 'https://ws.cedarpad.com/sub' }))).toEqual({
      a: 'https://ws.cedarpad.com',
    });
  });
});

describe('staysOnContainer', () => {
  // A question ABOUT the container must be answered BY the container: the guest
  // runs from a checkout and reports `dev`, which stalled a real deploy poll.
  test('/api/buildrev never follows a workspace off Cloudflare', () => {
    expect(staysOnContainer('/api/buildrev')).toBe(true);
  });

  test('the pad and the API do follow it', () => {
    expect(staysOnContainer('/w/default/canvas/c1/pad')).toBe(false);
    expect(staysOnContainer('/api/alive')).toBe(false);
    expect(staysOnContainer('/src/App.tsx')).toBe(false);
  });
});

describe('selfHostedTarget', () => {
  test('resolves a mapped workspace when every credential is present', () => {
    expect(selfHostedTarget({ SELF_HOSTED_WORKSPACES: MAP, ...CREDS }, 'default')).toEqual(TARGET);
  });

  test('an unmapped workspace stays on the container', () => {
    expect(selfHostedTarget({ SELF_HOSTED_WORKSPACES: MAP, ...CREDS }, 'ws_other')).toBeNull();
  });

  // Half-configured is the dangerous state — better the old behaviour than a
  // workspace that 403s on every request.
  test.each(['WS_SUPERVISOR_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'])(
    'falls back to the container when %s is missing',
    (missing) => {
      const env: Record<string, string> = { SELF_HOSTED_WORKSPACES: MAP, ...CREDS };
      delete env[missing];
      expect(selfHostedTarget(env, 'default')).toBeNull();
    },
  );
});

describe('guestRequest', () => {
  test('preserves path, query and method, and attaches the Access token', () => {
    const req = guestRequest(
      new Request('https://app.cedarpad.com/w/default/canvas/c1/pad?x=1'),
      'https://ws.cedarpad.com',
      TARGET,
    );
    expect(new URL(req.url).origin).toBe('https://ws.cedarpad.com');
    expect(new URL(req.url).pathname).toBe('/w/default/canvas/c1/pad');
    expect(new URL(req.url).search).toBe('?x=1');
    expect(req.headers.get('CF-Access-Client-Id')).toBe('cid.access');
    expect(req.headers.get('CF-Access-Client-Secret')).toBe('csecret');
  });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('serveSelfHosted', () => {
  test('warm hit proxies straight through, no boot', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      return new Response('pad', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), TARGET, {}, COORDS);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://ws.cedarpad.com/pad']);
    expect(calls.some((c) => c.includes('__boot'))).toBe(false);
  });

  test('an unreachable guest is booted with the pushed env, then retried', async () => {
    const seen: Array<{ url: string; body?: string }> = [];
    let first = true;
    globalThis.fetch = mock(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/__boot')) {
        seen.push({ url, body: init?.body as string });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      seen.push({ url });
      if (first) {
        first = false;
        throw new TypeError('connection refused');
      }
      return new Response('pad', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await serveSelfHosted(
      new Request('https://app.cedarpad.com/pad'),
      TARGET,
      { R2_BUCKET: 'b', CANVAS_WORKSPACE: 'default' },
      COORDS,
    );
    expect(res.status).toBe(200);
    // The env the Worker holds is what starts the stack — the guest stores none.
    expect(JSON.parse(seen[1]!.body!)).toEqual({ R2_BUCKET: 'b', CANVAS_WORKSPACE: 'default' });
    expect(seen.map((s) => s.url)).toEqual([
      'https://ws.cedarpad.com/pad',
      'https://ws.cedarpad.com/__boot',
      'https://ws.cedarpad.com/pad',
    ]);
  });

  test('a failed boot answers a stream with a retryable SSE, never an error page', async () => {
    globalThis.fetch = mock(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/__boot')) return new Response('nope', { status: 500 });
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    const res = await serveSelfHosted(
      new Request('https://app.cedarpad.com/api/chat/stream', { headers: { accept: 'text/event-stream' } }),
      TARGET,
      {},
      COORDS,
    );
    // EventSource does not reconnect after a non-SSE error — the tab would go dead.
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  test('a failed boot on a normal request is a 502, not a silent 200', async () => {
    globalThis.fetch = mock(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/__boot')) return new Response('nope', { status: 500 });
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    const res = await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), TARGET, {}, COORDS);
    expect(res.status).toBe(502);
  });

  test('the boot push carries the supervisor bearer AND the Access token', async () => {
    let bootInit: RequestInit | undefined;
    globalThis.fetch = mock(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/__boot')) {
        bootInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (!bootInit) throw new TypeError('connection refused');
      return new Response('pad', { status: 200 });
    }) as unknown as typeof fetch;

    await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), TARGET, {}, COORDS);
    const headers = bootInit!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sup-token');
    expect(headers['CF-Access-Client-Id']).toBe('cid.access');
  });
});
