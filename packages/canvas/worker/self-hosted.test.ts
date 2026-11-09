import { afterEach, describe, expect, mock, test } from 'bun:test';
import { decideGuestWarm, guestRequest, parseWorkspaceMap, selfHostedTarget, serveSelfHosted } from './self-hosted.ts';
import type { SelfHostedTarget } from './self-hosted.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

const CREDS = {
  WS_SUPERVISOR_TOKEN: 'sup-token',
  CF_ACCESS_CLIENT_ID: 'cid.access',
  CF_ACCESS_CLIENT_SECRET: 'csecret',
};
const MAP = JSON.stringify({ default: 'https://ws.cedarpad.com' });
// A sandbox on sbx: the stack and the supervisor are two addresses (`<port>-<name>` reaches a port of its own).
const SBX_STACK = 'https://cedarpad-default.sbx.zabaca.com';
const SBX_SUPERVISOR = 'https://4599-cedarpad-default.sbx.zabaca.com';
const SBX_MAP = JSON.stringify({ default: { stack: SBX_STACK, supervisor: SBX_SUPERVISOR } });
const COORDS: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };
const TARGET: SelfHostedTarget = {
  origin: 'https://ws.cedarpad.com',
  supervisorOrigin: 'https://ws.cedarpad.com',
  sandbox: false,
  supervisorToken: 'sup-token',
  accessClientId: 'cid.access',
  accessClientSecret: 'csecret',
};
const SBX_TARGET: SelfHostedTarget = { ...TARGET, origin: SBX_STACK, supervisorOrigin: SBX_SUPERVISOR, sandbox: true };

describe('parseWorkspaceMap', () => {
  test('the plain form names one origin for the stack and the supervisor both', () => {
    expect(parseWorkspaceMap(MAP)).toEqual({
      default: { origin: 'https://ws.cedarpad.com', supervisorOrigin: 'https://ws.cedarpad.com', sandbox: false },
    });
  });

  test('the two-origin form names the stack and the supervisor apart, and is a sandbox', () => {
    expect(parseWorkspaceMap(SBX_MAP)).toEqual({
      default: { origin: SBX_STACK, supervisorOrigin: SBX_SUPERVISOR, sandbox: true },
    });
  });

  // A workspace whose entry is half there is not self-hosted; the others are unaffected.
  test('a two-origin entry with a missing, non-https or malformed origin is dropped, the rest kept', () => {
    const map = JSON.stringify({
      a: { stack: SBX_STACK },
      b: { stack: SBX_STACK, supervisor: 'http://4599-x.sbx.zabaca.com' },
      c: { stack: SBX_STACK, supervisor: 7 },
      d: { stack: SBX_STACK, supervisor: SBX_SUPERVISOR },
    });
    expect(Object.keys(parseWorkspaceMap(map))).toEqual(['d']);
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
    const one = parseWorkspaceMap(JSON.stringify({ a: 'https://ws.cedarpad.com/sub' }));
    expect(one.a?.origin).toBe('https://ws.cedarpad.com');
    const two = parseWorkspaceMap(JSON.stringify({ a: { stack: `${SBX_STACK}/x`, supervisor: `${SBX_SUPERVISOR}/y` } }));
    expect(two.a).toEqual({ origin: SBX_STACK, supervisorOrigin: SBX_SUPERVISOR, sandbox: true });
  });
});

describe('decideGuestWarm', () => {
  // The 2026-08-14 regression: cloudflared answers 502 when the guest's origin
  // is down, decideWarm() called that 'serve', and a Cloudflare "Bad gateway"
  // page was handed to the user instead of booting the workspace.
  test.each([502, 503, 504])('%d from the edge means the origin is not serving', (s) => {
    expect(decideGuestWarm(s)).toBe('cold-start');
  });

  test('real app responses pass through — a failed login is not a cold start', () => {
    for (const s of [200, 204, 302, 401, 403, 404, 500]) {
      expect(decideGuestWarm(s)).toBe('serve');
      expect(decideGuestWarm(s, true)).toBe('serve');
    }
  });

  // sbx answers 410 for a sandbox whose pod is gone ("lost"). A sandbox flagged start-fresh starts again from its
  // image, so for it a 410 is a workspace with its stack down, the same as a 502: the boot reaches the fresh pod.
  test.each([502, 503, 504, 410])('%d from sbx means the sandbox is not serving', (s) => {
    expect(decideGuestWarm(s, true)).toBe('cold-start');
  });

  // Behind the VM's tunnel nothing answers 410, so it is a real response there and stays one.
  test('a 410 behind a tunnel is not a cold start', () => {
    expect(decideGuestWarm(410)).toBe('serve');
  });
});

describe('selfHostedTarget', () => {
  test('resolves a mapped workspace when every credential is present', () => {
    expect(selfHostedTarget({ SELF_HOSTED_WORKSPACES: MAP, ...CREDS }, 'default')).toEqual(TARGET);
  });

  test('a two-origin entry resolves to a sandbox target', () => {
    expect(selfHostedTarget({ SELF_HOSTED_WORKSPACES: SBX_MAP, ...CREDS }, 'default')).toEqual(SBX_TARGET);
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
      expect(selfHostedTarget({ ...env, SELF_HOSTED_WORKSPACES: SBX_MAP }, 'default')).toBeNull();
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

  // The Worker has already decided the caller may reach the workspace, so a request it forwards must wake a
  // sleeping sandbox whoever sent it: sbx would otherwise answer "asleep" to a share-link preview bot's User-Agent
  // or a HEAD. The header is the Worker's to set, so a caller's own value (X-Sbx-Wake: 0) does not survive.
  test('a sandbox request carries the always-wake header, whatever the caller sent', () => {
    const req = guestRequest(
      new Request('https://app.cedarpad.com/pad', { headers: { 'x-sbx-wake': '0', 'user-agent': 'Slackbot-LinkExpanding' } }),
      SBX_STACK,
      SBX_TARGET,
    );
    expect(req.headers.get('x-sbx-wake')).toBe('1');
  });

  test('a VM request does not carry it', () => {
    const req = guestRequest(new Request('https://app.cedarpad.com/pad'), 'https://ws.cedarpad.com', TARGET);
    expect(req.headers.has('x-sbx-wake')).toBe(false);
  });

  // The Access service token rides every one of these requests: the path must never be able to pick the host.
  test.each([['//attacker.example/x'], ['/\\attacker.example/x'], ['/%2F%2Fattacker.example/x'], ['/%5Cattacker.example/x']])(
    'a request for %s is sent to the target, not to another host',
    (path) => {
      for (const [origin, target] of [
        ['https://ws.cedarpad.com', TARGET],
        [SBX_STACK, SBX_TARGET],
      ] as const) {
        const req = guestRequest(new Request(`https://app.cedarpad.com${path}`), origin, target);
        expect(new URL(req.url).origin).toBe(origin);
        expect(req.headers.get('CF-Access-Client-Id')).toBe('cid.access');
      }
    },
  );
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

  test('a 502 from the edge boots the guest instead of serving the error page', async () => {
    const seen: string[] = [];
    let booted = false;
    globalThis.fetch = mock(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      seen.push(url);
      if (url.endsWith('/__boot')) {
        booted = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // cloudflared's answer when vite is not listening: a Response, not a throw.
      return booted ? new Response('pad', { status: 200 }) : new Response('Bad gateway', { status: 502 });
    }) as unknown as typeof fetch;

    const res = await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), TARGET, {}, COORDS);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pad');
    expect(seen.some((u) => u.endsWith('/__boot'))).toBe(true);
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

  test('the VM path boots at the same origin, as before', async () => {
    const seen: string[] = [];
    let booted = false;
    globalThis.fetch = mock(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      seen.push(url);
      if (url.endsWith('/__boot')) {
        booted = true;
        return new Response('{}', { status: 200 });
      }
      return booted ? new Response('pad') : new Response('Bad gateway', { status: 502 });
    }) as unknown as typeof fetch;
    await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), TARGET, {}, COORDS);
    expect(seen).toEqual(['https://ws.cedarpad.com/pad', 'https://ws.cedarpad.com/__boot', 'https://ws.cedarpad.com/pad']);
  });
});

describe('serveSelfHosted on a sandbox', () => {
  // Every fetch the Worker makes, with the headers it carried.
  type Seen = { url: string; wake: string | null; access: string | null };
  const harness = (answer: (url: string, n: number) => Response | Error) => {
    const seen: Seen[] = [];
    globalThis.fetch = mock(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers as Record<string, string>);
      seen.push({ url, wake: headers.get('x-sbx-wake'), access: headers.get('cf-access-client-id') });
      const r = answer(url, seen.length);
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    return seen;
  };

  test('a warm sandbox serves from the stack address with the wake header, no boot', async () => {
    const seen = harness(() => new Response('pad'));
    const res = await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), SBX_TARGET, {}, COORDS);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ url: `${SBX_STACK}/pad`, wake: '1', access: 'cid.access' }]);
  });

  // The stack is down while the sandbox sleeps: the wake request reaches vite's closed port, and the boot, at the
  // supervisor's own address, starts it. Both requests carry the wake header (a boot is the Worker's too).
  test('a cold stack is booted at the supervisor address, and every request wakes', async () => {
    let booted = false;
    const seen = harness((url) => {
      if (url === `${SBX_SUPERVISOR}/__boot`) {
        booted = true;
        return new Response('{}');
      }
      return booted ? new Response('pad') : new Response('Bad gateway', { status: 502 });
    });
    const res = await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), SBX_TARGET, { R2_BUCKET: 'b' }, COORDS);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual([`${SBX_STACK}/pad`, `${SBX_SUPERVISOR}/__boot`, `${SBX_STACK}/pad`]);
    expect(seen.every((s) => s.wake === '1' && s.access === 'cid.access')).toBe(true);
  });

  test('a lost sandbox (sbx answers 410) is a cold workspace: the boot is pushed and the request retried', async () => {
    let booted = false;
    const seen = harness((url) => {
      if (url.endsWith('/__boot')) {
        booted = true;
        return new Response('{}');
      }
      return booted ? new Response('pad') : new Response('this sandbox was lost\n', { status: 410 });
    });
    const res = await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), SBX_TARGET, {}, COORDS);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pad');
    expect(seen.map((s) => s.url)).toEqual([`${SBX_STACK}/pad`, `${SBX_SUPERVISOR}/__boot`, `${SBX_STACK}/pad`]);
  });

  test('the boot carries the supervisor bearer and the pushed env', async () => {
    let bootInit: RequestInit | undefined;
    globalThis.fetch = mock(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/__boot')) {
        bootInit = init;
        return new Response('{}');
      }
      if (!bootInit) return new Response('', { status: 410 });
      return new Response('pad');
    }) as unknown as typeof fetch;
    await serveSelfHosted(new Request('https://app.cedarpad.com/pad'), SBX_TARGET, { R2_BUCKET: 'b' }, COORDS);
    const headers = bootInit!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sup-token');
    expect(headers['X-Sbx-Wake']).toBe('1');
    expect(JSON.parse(bootInit!.body as string)).toEqual({ R2_BUCKET: 'b' });
  });

  test('a 410 on a stream whose boot fails is a retryable SSE, never the error page', async () => {
    harness((url) => (url.endsWith('/__boot') ? new Response('nope', { status: 410 }) : new Response('', { status: 410 })));
    const res = await serveSelfHosted(
      new Request('https://app.cedarpad.com/api/chat/stream', { headers: { accept: 'text/event-stream' } }),
      SBX_TARGET,
      {},
      COORDS,
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  // The public /api/buildrev: anyone can poll it, so on a sandbox it asks sbx NOT to wake it (X-Sbx-Wake: 0) and never
  // boots the stack. A sleeping sandbox or a down stack answers 503 and stays as it was.
  describe('passively (the public build stamp)', () => {
    const passive = (path = '/api/buildrev') =>
      serveSelfHosted(new Request(`https://app.cedarpad.com${path}`), SBX_TARGET, { R2_BUCKET: 'b' }, COORDS, { passive: true });

    test('a running stack answers, and the request asks not to wake', async () => {
      const seen = harness(() => new Response('{"buildRev":"abc1234"}'));
      const res = await passive();
      expect(res.status).toBe(200);
      expect(seen).toEqual([{ url: `${SBX_STACK}/api/buildrev`, wake: '0', access: 'cid.access' }]);
    });

    test.each([
      ['asleep: sbx refuses to wake for it', 503],
      ['the stack is down', 502],
      ['lost', 410],
    ])('%s: a 503, no boot, nothing woken', async (_why, status) => {
      const seen = harness(() => new Response('x', { status }));
      const res = await passive();
      expect(res.status).toBe(503);
      expect(seen.map((s) => s.url)).toEqual([`${SBX_STACK}/api/buildrev`]);
      expect(seen[0]!.wake).toBe('0');
    });

    test('an unreachable sandbox is a 503 too, with no boot', async () => {
      const seen = harness(() => new TypeError('connection refused'));
      expect((await passive()).status).toBe(503);
      expect(seen).toHaveLength(1);
    });

    test('a real app error passes through', async () => {
      harness(() => new Response('boom', { status: 500 }));
      expect((await passive()).status).toBe(500);
    });

    // The VM is on its tunnel and has no wake to ask for: unchanged.
    test('behind the VM it is the same as before', async () => {
      const seen: string[] = [];
      globalThis.fetch = mock(async (input: Request | string) => {
        seen.push(typeof input === 'string' ? input : input.url);
        return new Response('ok');
      }) as unknown as typeof fetch;
      await serveSelfHosted(new Request('https://app.cedarpad.com/api/buildrev'), TARGET, {}, COORDS, { passive: true });
      expect(seen).toEqual(['https://ws.cedarpad.com/api/buildrev']);
    });
  });
});
