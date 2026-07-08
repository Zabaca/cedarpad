// #79: the agent chat draws on the ACTIVE canvas's session, not always the default.
//
// Before #53 the bridge held one CanvasStore; since then it holds N (keyed by canvasId),
// but runChatTurn still used defaultSession.store — so the agent's writes always landed on
// the default canvas no matter which one the human was on. We fix runChatTurn to resolve the
// request's canvas (x-canvas-id / ?canvas, default 'default') and run the turn against THAT
// session's store.
//
// To assert this without the real Agent SDK we mock.module('./agent.ts') so runChat is a fake
// that just writes one shape into whatever store the bridge hands it. Then a /send with
// x-canvas-id=B must make that shape readable at GET /api/canvas (x-canvas-id=B) and leave the
// default (and a third canvas C) empty. The dispatcher is left as the REAL runChatTurn so this
// exercises the actual session-resolution path. Because runChatTurn is fire-and-forget, we poll
// GET /api/canvas until the shape appears.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { CanvasShape } from '../src/shapes.ts';

// The fake runChat: write a marker shape into the store the bridge passed as arg 0, then finish.
// A null sessionId keeps runChatTurn off the transcript-backup branch.
mock.module('./agent.ts', () => ({
  async *runChat(store: { upsert(s: CanvasShape[]): number }, message: string) {
    const shape: CanvasShape = { id: `shape:${message}`, type: 'note', color: 'black', x: 0, y: 0, text: message };
    store.upsert([shape]);
    yield { kind: 'done', sessionId: null, costUsd: 0 };
  },
}));

const { chatClients, handleRequest } = await import('./bridge.ts');

const send = (chatId: string, canvasId: string | null, message: string): Request =>
  new Request(`http://localhost/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(canvasId ? { 'x-canvas-id': canvasId } : {}) },
    body: JSON.stringify({ message }),
  });

const shapesOn = async (canvasId: string): Promise<CanvasShape[]> => {
  const res = await handleRequest(
    new Request('http://localhost/api/canvas', { headers: { 'x-canvas-id': canvasId } }),
  );
  return ((await res.json()) as { shapes: CanvasShape[] }).shapes;
};

// Fire-and-forget turn: poll the target canvas until the agent's shape lands (or time out).
const waitForShape = async (canvasId: string, id: string, tries = 50): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if ((await shapesOn(canvasId)).some((s) => s.id === id)) return true;
    await Bun.sleep(10);
  }
  return false;
};

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('agent chat routes to the active canvas session (#79)', () => {
  let sub: ReadableStreamDefaultController;
  beforeEach(() => {
    sub = fakeSubscriber(); // one subscriber = the /send guard passes
    chatClients.add(sub);
  });
  afterEach(() => {
    for (const c of [...chatClients]) chatClients.delete(c);
  });

  test('a turn sent with x-canvas-id=B creates the shape in canvas B, not the default', async () => {
    const res = await handleRequest(send('chat_b', 'canvasB', 'onB'));
    expect(res.status).toBe(202);

    expect(await waitForShape('canvasB', 'shape:onB')).toBe(true);
    expect((await shapesOn('default')).some((s) => s.id === 'shape:onB')).toBe(false);
  });

  test('per-canvas isolation: a turn on B leaves the default and another canvas C untouched', async () => {
    const res = await handleRequest(send('chat_iso', 'canvasIsoB', 'iso'));
    expect(res.status).toBe(202);
    expect(await waitForShape('canvasIsoB', 'shape:iso')).toBe(true);

    expect((await shapesOn('default')).some((s) => s.id === 'shape:iso')).toBe(false);
    expect((await shapesOn('canvasIsoC')).some((s) => s.id === 'shape:iso')).toBe(false);
  });

  test('no canvas selection resolves to the default session (behavior-preserving)', async () => {
    const res = await handleRequest(send('chat_default', null, 'noSel'));
    expect(res.status).toBe(202);

    expect(await waitForShape('default', 'shape:noSel')).toBe(true);
  });
});
