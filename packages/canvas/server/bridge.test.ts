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

import { chatClients, handleRequest, setChatTurnDispatcher } from './bridge.ts';

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
  let dispatched: Array<{ chatId: string; message: string }> = [];

  beforeEach(() => {
    for (const c of [...chatClients]) chatClients.delete(c); // no subscribers by default
    dispatched = [];
    restore = setChatTurnDispatcher((chatId, message) => {
      dispatched.push({ chatId, message });
    });
  });

  afterEach(() => {
    restore();
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

describe('/api/buildrev: public build stamp (#74)', () => {
  test('returns ONLY buildRev — none of /api/status persistence/client fields', async () => {
    const res = await handleRequest(new Request('http://localhost/api/buildrev'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Exactly one field: the SHA stamp. No backend/degraded/save/clients/etc.
    expect(Object.keys(body)).toEqual(['buildRev']);
    expect(typeof body.buildRev).toBe('string');
  });
});
