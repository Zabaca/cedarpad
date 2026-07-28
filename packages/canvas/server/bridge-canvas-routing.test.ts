// #79: the agent chat draws on the ACTIVE canvas's session, not always the default.
//
// Before #53 the bridge held one CanvasStore; since then it holds N (keyed by canvasId),
// but runChatTurn still used defaultSession.store — so the agent's writes always landed on
// the default canvas no matter which one the human was on. We fix runChatTurn to resolve the
// request's canvas (x-canvas-id / ?canvas, default 'default') and run the turn against THAT
// session's store.
//
// To assert this without the real Agent SDK we swap the turn's agent via `setTurnRunChat`
// (the live-object seam on bridge's turnDeps) for a fake that just writes one shape into
// whatever store the bridge hands it. The dispatcher stays the REAL runChatTurn, so this
// exercises the actual session-resolution path. NOT `mock.module('./agent.ts')`: bun's
// module cache binds bridge.ts to the real agent.ts as soon as any earlier test file
// imports it, so that mock silently never applied in full-suite runs — and the tests kept
// "passing" only where `.persist` still held marker shapes from an old run (#170). The
// marker ids are unique per run for the same reason: state persisted by a previous run must
// never satisfy this one. Because runChatTurn is fire-and-forget, we poll until it lands.
//
// #305 changed WHERE we look. Canvas writes from the bridge's own handlers now go to the
// canvas's Durable-Object-hosted room, and GET /api/canvas reads the room — but the CHAT
// TURN still receives the in-memory session store (`turnDeps`, server/turn.ts), which #305
// deliberately did not touch: a turn holds one store across many tool calls, so it needs a
// flush cadence the per-call open→mutate→flush→discard shape does not answer. That is an
// open gap, not a decision this test can paper over, so the assertion moved OFF the read
// route and onto the store the turn was actually handed: distinct canvases must get
// distinct stores, and each marker must land in its own.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { CanvasShape } from '../src/shapes.ts';
import type { runChat } from './agent.ts';
import { chatHub, handleRequest, setTurnRunChat } from './bridge.ts';

type TurnStore = { upsert(s: CanvasShape[]): number; getState(): { shapes: CanvasShape[] } };

/** message → the store the bridge handed that turn. Identity is the assertion: two messages
 *  routed to the same canvas share a store, two canvases never do. */
const storeOf = new Map<string, TurnStore>();

// The fake runChat: write a marker shape into the store the bridge passed as arg 0, then
// finish. A null sessionId keeps runChatTurn off the transcript-backup branch.
const fakeRunChat = async function* (store: TurnStore, message: string) {
  const shape: CanvasShape = { id: `shape:${message}`, type: 'note', color: 'black', x: 0, y: 0, text: message };
  store.upsert([shape]);
  storeOf.set(message, store);
  yield { kind: 'done', sessionId: null, costUsd: 0 };
} as unknown as typeof runChat;

// Marker suffix unique to this run — a stale `.persist` blob can't contain these ids.
const RUN = Math.random().toString(36).slice(2, 8);

const send = (chatId: string, canvasId: string | null, message: string): Request =>
  new Request(`http://localhost/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(canvasId ? { 'x-canvas-id': canvasId } : {}) },
    body: JSON.stringify({ message }),
  });

/** Fire-and-forget turn: wait until the turn has run and report the store it was given. */
const storeForTurn = async (message: string, tries = 50): Promise<TurnStore> => {
  for (let i = 0; i < tries; i++) {
    const store = storeOf.get(message);
    if (store) return store;
    await Bun.sleep(10);
  }
  throw new Error(`turn for ${message} never ran`);
};

const has = (store: TurnStore, id: string): boolean => store.getState().shapes.some((s) => s.id === id);

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('agent chat routes to the active canvas session (#79)', () => {
  let sub: ReadableStreamDefaultController;
  let restoreRunChat: () => void;
  beforeEach(() => {
    sub = fakeSubscriber(); // one subscriber = the /send guard passes
    chatHub.subscribe(sub);
    restoreRunChat = setTurnRunChat(fakeRunChat);
  });
  afterEach(() => {
    restoreRunChat();
    chatHub.resetForTests();
  });

  test('a turn sent with x-canvas-id=B creates the shape in canvas B, not the default', async () => {
    expect((await handleRequest(send('chat_b', 'canvasB', `onB-${RUN}`))).status).toBe(202);
    expect((await handleRequest(send('chat_d', null, `onD-${RUN}`))).status).toBe(202);

    const onB = await storeForTurn(`onB-${RUN}`);
    const onDefault = await storeForTurn(`onD-${RUN}`);
    expect(onB).not.toBe(onDefault);
    expect(has(onB, `shape:onB-${RUN}`)).toBe(true);
    expect(has(onDefault, `shape:onB-${RUN}`)).toBe(false);
  });

  test('per-canvas isolation: a turn on B leaves another canvas C untouched', async () => {
    expect((await handleRequest(send('chat_iso', 'canvasIsoB', `iso-${RUN}`))).status).toBe(202);
    expect((await handleRequest(send('chat_isoc', 'canvasIsoC', `isoC-${RUN}`))).status).toBe(202);

    const onB = await storeForTurn(`iso-${RUN}`);
    const onC = await storeForTurn(`isoC-${RUN}`);
    expect(onB).not.toBe(onC);
    expect(has(onC, `shape:iso-${RUN}`)).toBe(false);
  });

  test('no canvas selection resolves to the default session, the same one every time', async () => {
    expect((await handleRequest(send('chat_default', null, `noSel-${RUN}`))).status).toBe(202);
    expect((await handleRequest(send('chat_default2', null, `noSel2-${RUN}`))).status).toBe(202);

    const first = await storeForTurn(`noSel-${RUN}`);
    expect(await storeForTurn(`noSel2-${RUN}`)).toBe(first);
    expect(has(first, `shape:noSel-${RUN}`)).toBe(true);
  });
});
