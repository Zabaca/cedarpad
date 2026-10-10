import { describe, expect, test } from 'bun:test';

import { POSTHOG_CAPTURE_URL, captureBody, proxiedRequestEvent, track, type UsageEvent } from './analytics.ts';

const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
};

const sent = (calls: Array<[string, RequestInit]>) => calls.map(([url, init]) => ({ url, body: JSON.parse(init.body as string) }));

describe('track: usage events to PostHog, in the background', () => {
  test('posts one capture with the key, event, distinct id and properties', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const c = ctx();
    track({ POSTHOG_KEY: 'phc_test' }, c, { event: 'canvas_created', distinctId: 'u1', properties: { workspace_id: 'w1', canvas_id: 'cv1' } }, (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch);
    await Promise.all(c.pending);

    const [one] = sent(calls);
    expect(one?.url).toBe(POSTHOG_CAPTURE_URL);
    expect(one?.body).toMatchObject({
      api_key: 'phc_test',
      event: 'canvas_created',
      distinct_id: 'u1',
      properties: { workspace_id: 'w1', canvas_id: 'cv1', $lib: 'cedarpad-edge' },
    });
  });

  test('without POSTHOG_KEY nothing is sent (preview, local dev)', () => {
    let called = false;
    const c = ctx();
    track({}, c, { event: 'chat_message_sent', distinctId: 'u1' }, (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof fetch);
    expect(called).toBe(false);
    expect(c.pending).toHaveLength(0);
  });

  test('a failing send is swallowed — neither the call nor the background promise throws', async () => {
    const c = ctx();
    expect(() =>
      track({ POSTHOG_KEY: 'k' }, c, { event: 'chat_message_sent', distinctId: 'u1' }, (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch),
    ).not.toThrow();
    await expect(Promise.all(c.pending)).resolves.toBeDefined();
  });

  test('a send that throws synchronously is swallowed too', () => {
    const c = ctx();
    expect(() =>
      track({ POSTHOG_KEY: 'k' }, c, { event: 'chat_message_sent', distinctId: 'u1' }, (() => {
        throw new Error('boom');
      }) as unknown as typeof fetch),
    ).not.toThrow();
  });
});

describe('captureBody: the no-content rule', () => {
  test('keys outside the vocabulary are dropped even when a caller casts past the type', () => {
    const e = {
      event: 'component_written',
      distinctId: 'u1',
      properties: { module: 'Chart', source: 'mcp', code: 'export default 1', message: 'secret plan', token: 'phc_x', email: 'a@b.c' },
    } as unknown as UsageEvent;
    const props = captureBody('k', e, new Date(0)).properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['$lib', 'module', 'source']);
  });

  test('non-string and empty values are dropped', () => {
    const e = { event: 'mcp_tool_called', distinctId: 'u1', properties: { tool: '', workspace_id: 42 } } as unknown as UsageEvent;
    expect(Object.keys(captureBody('k', e, new Date(0)).properties as object)).toEqual(['$lib']);
  });

  test('an anonymous (guest) event creates no person profile', () => {
    const props = captureBody('k', { event: 'guest_link_opened', distinctId: 'share:l1', anonymous: true }, new Date(0)).properties;
    expect(props).toMatchObject({ $process_person_profile: false });
  });
});

describe('proxiedRequestEvent: which proxied member requests count', () => {
  test('a chat send', () => {
    expect(proxiedRequestEvent('POST', '/api/chat/c1/send', 'cv1')).toEqual({ event: 'chat_message_sent', properties: { canvas_id: 'cv1' } });
  });

  test('component and data writes name the module, never the body', () => {
    expect(proxiedRequestEvent('PUT', '/api/components/Chart', null)).toEqual({ event: 'component_written', properties: { module: 'Chart', source: 'app' } });
    expect(proxiedRequestEvent('PATCH', '/api/components/Chart', 'cv1')?.properties).toEqual({ canvas_id: 'cv1', module: 'Chart', source: 'app' });
    expect(proxiedRequestEvent('PUT', '/api/components/data/rows.json', null)?.properties).toMatchObject({ module: 'rows.json' });
  });

  test('reads, promote/adopt and everything else do not count', () => {
    expect(proxiedRequestEvent('GET', '/api/components/Chart', null)).toBeNull();
    expect(proxiedRequestEvent('POST', '/api/components/promote', null)).toBeNull();
    expect(proxiedRequestEvent('PUT', '/api/components/place', null)).toBeNull();
    expect(proxiedRequestEvent('GET', '/api/canvas/stream', null)).toBeNull();
  });
});
