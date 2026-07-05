// The /api/chat/:id/send subscribe-before-send wire contract (425 Too Early).
//
// Importing bridge.ts does NOT bind a port (Bun.serve is guarded behind
// `import.meta.main`), so we drive the exported `handleRequest` directly with a
// Request and assert the response. `setChatTurnDispatcher` swaps in a spy so the
// 2xx path never invokes the real agent SDK and we can assert dispatch happened (or,
// on the 425 path, did NOT). `chatClients` is the shared subscriber set the guard
// consults — one connected stream carries every chat, so a single fake controller
// represents "a subscriber exists".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { chatClients, handleRequest, setChatTurnDispatcher, setSessionCheck } from './bridge.ts';

const sendReq = (chatId: string, body: unknown = { message: 'hi' }): Request =>
  new Request(`http://localhost/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('/api/chat/:id/send: subscribe-before-send (425)', () => {
  let restore: () => void = () => {};
  let restoreSession: () => void = () => {};
  let dispatched: Array<{ chatId: string; message: string }> = [];

  beforeEach(() => {
    for (const c of [...chatClients]) chatClients.delete(c); // no subscribers by default
    dispatched = [];
    restoreSession = setSessionCheck(async () => true); // these tests assume an authed caller
    restore = setChatTurnDispatcher((chatId, message) => {
      dispatched.push({ chatId, message });
    });
  });

  afterEach(() => {
    restore();
    restoreSession();
    for (const c of [...chatClients]) chatClients.delete(c);
  });

  test('no subscriber → 425 Too Early with {error,chatId}, and no turn is dispatched', async () => {
    const res = await handleRequest(sendReq('chat_no_sub'));

    expect(res.status).toBe(425);
    expect(await res.json()).toEqual({ error: 'no_subscribers', chatId: 'chat_no_sub' });
    expect(dispatched).toEqual([]); // dispatched nothing
  });

  test('425 fires before the body is even inspected (an otherwise-valid send is still rejected)', async () => {
    const res = await handleRequest(sendReq('chat_valid_body', { message: 'a real, non-empty message' }));

    expect(res.status).toBe(425);
    expect(dispatched).toEqual([]);
  });

  test('with an active subscription → 202 Accepted and the turn IS dispatched', async () => {
    const sub = fakeSubscriber();
    chatClients.add(sub);

    const res = await handleRequest(sendReq('chat_subbed', { message: 'go' }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatched).toEqual([{ chatId: 'chat_subbed', message: 'go' }]);
  });
});

describe('canvas API auth gate', () => {
  let restore: () => void = () => {};
  let dispatched: string[] = [];

  beforeEach(() => {
    dispatched = [];
    restore = setChatTurnDispatcher((chatId) => {
      dispatched.push(chatId);
    });
  });

  afterEach(() => {
    restore();
  });

  test('no session → 401 on canvas routes, nothing dispatched', async () => {
    // The real checkSession is in place; a bare request has no cookie → refused.
    for (const path of ['/api/canvas', '/api/chat/c1/send', '/api/capture/list']) {
      const res = await handleRequest(new Request(`http://localhost${path}`, { method: path.endsWith('/send') ? 'POST' : 'GET' }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(dispatched).toEqual([]);
  });

  test('health and status stay open without a session', async () => {
    const health = await handleRequest(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);
    const status = await handleRequest(new Request('http://localhost/api/status'));
    expect(status.status).toBe(200);
  });

  test('x-internal-key matching CANVAS_INTERNAL_KEY bypasses the session gate', async () => {
    const prev = process.env.CANVAS_INTERNAL_KEY;
    process.env.CANVAS_INTERNAL_KEY = 'test-internal-key';
    try {
      const ok = await handleRequest(
        new Request('http://localhost/api/canvas', { headers: { 'x-internal-key': 'test-internal-key' } }),
      );
      expect(ok.status).toBe(200);
      const bad = await handleRequest(
        new Request('http://localhost/api/canvas', { headers: { 'x-internal-key': 'wrong' } }),
      );
      expect(bad.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.CANVAS_INTERNAL_KEY;
      else process.env.CANVAS_INTERNAL_KEY = prev;
    }
  });

  test('a stubbed valid session passes the gate', async () => {
    const restoreSession = setSessionCheck(async () => true);
    try {
      const res = await handleRequest(new Request('http://localhost/api/canvas'));
      expect(res.status).toBe(200);
    } finally {
      restoreSession();
    }
  });
});
