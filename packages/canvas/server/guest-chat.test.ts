// Guest chat confinement at the bridge (PRD #220 slice 6, ADR-0015).
//
// The edge stamps `x-guest-canvas: <canvasId>` on EVERY proxied guest request (the guest
// gate already confined the path set). Bridge-side this header means: member conversations
// are view-only (a guest send to an established, non-guest chat is 403), a guest may start
// and continue their OWN chats addressed to exactly that canvas, and the shared chat SSE
// delivers a guest only the frames of chats known to live on that canvas.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { broadcastChatEvent, chatHub, handleRequest, indexSessionStart, setChatTurnDispatcher } from './bridge.ts';

const guestSend = (chatId: string, canvas: string | null, guestCanvas = 'cv_g', body: unknown = { message: 'hi' }) =>
  new Request(`http://localhost/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-guest-canvas': guestCanvas,
      ...(canvas ? { 'x-canvas-id': canvas } : {}),
    },
    body: JSON.stringify(body),
  });

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('guest sends (#220 slice 6)', () => {
  let restore: () => void = () => {};
  let dispatched: string[] = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber()); // sends need a subscriber (425 guard)
    restore = setChatTurnDispatcher((chatId) => {
      dispatched.push(chatId);
    });
  });
  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test("a guest starts their OWN chat on the link's canvas: 202, dispatched", async () => {
    const res = await handleRequest(guestSend(`guest_new_${Date.now()}`, 'cv_g'));
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });

  test('a guest send addressed to ANOTHER canvas — or to none — is 403, nothing dispatched', async () => {
    for (const canvas of ['cv_other', null]) {
      const res = await handleRequest(guestSend('guest_stray', canvas));
      expect(res.status).toBe(403);
    }
    expect(dispatched).toEqual([]);
  });

  test('a guest send into an ESTABLISHED member conversation is 403 (view-only), nothing dispatched', async () => {
    await indexSessionStart('member_chat_1', 'sess_member_1', 'member thread', 'default', 'cv_g');
    const res = await handleRequest(guestSend('member_chat_1', 'cv_g'));
    expect(res.status).toBe(403);
    expect(dispatched).toEqual([]);
  });

  test('a guest CAN continue the chat they started (it is theirs, not view-only)', async () => {
    const chatId = `guest_mine_${Date.now()}`;
    await handleRequest(guestSend(chatId, 'cv_g'));
    // The first turn established a session for it — a member chat would now be locked.
    await indexSessionStart(chatId, 'sess_guest_1', 'guest thread', 'default', 'cv_g');
    const res = await handleRequest(guestSend(chatId, 'cv_g'));
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([chatId, chatId]);
  });
});

describe('guest chat stream filtering (#220 slice 6)', () => {
  afterEach(() => {
    chatHub.resetForTests();
  });

  test("a guest stream receives frames ONLY for chats known to live on the link's canvas", async () => {
    // Bind two chats to canvases via the session index (the same call the turn makes).
    await indexSessionStart('stream_mine', 'sess_sm', 'on the shared canvas', 'default', 'cv_g');
    await indexSessionStart('stream_other', 'sess_so', 'elsewhere', 'default', 'cv_other');

    const res = await handleRequest(
      new Request('http://localhost/api/chat/stream', { headers: { 'x-guest-canvas': 'cv_g' } }),
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read(); // ': subscribed' comment frame
    expect(new TextDecoder().decode(first.value)).toContain('subscribed');

    broadcastChatEvent('stream_other', { type: 'status', status: 'thinking' } as never);
    broadcastChatEvent('stream_mine', { type: 'status', status: 'thinking' } as never);
    broadcastChatEvent('unmapped_chat', { type: 'status', status: 'thinking' } as never);

    // The ONLY data frame delivered must be stream_mine's — if the filter leaked, the
    // first read after 'subscribed' would be stream_other's frame instead.
    const frame = await reader.read();
    const text = new TextDecoder().decode(frame.value);
    expect(text).toContain('stream_mine');
    expect(text).not.toContain('stream_other');
    await reader.cancel();
  });
});
