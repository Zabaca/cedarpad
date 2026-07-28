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
// #310 closed the gap #305 left: the CHAT TURN now draws into the canvas's
// Durable-Object-hosted room too, through a per-turn store settled after every tool call
// (server/turn-canvas-store.ts). So routing is asserted where it is now observable — in the
// ROOM the turn opened. The fake agent goes through the REAL canvas tool handler, so what is
// exercised is the whole path: session resolution → room open → op → commit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { CanvasShape } from '../src/shapes.ts';
import { createCanvasTools, type runChat } from './agent.ts';
import { chatHub, handleRequest, setCanvasRoomOpener, setTurnRunChat } from './bridge.ts';
import { createStore, type CanvasStore } from '../src/store.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';

type TurnStore = CanvasStore;

/** canvasId → that canvas's room. Mutations only reach it on flush, like the real one. */
const rooms = new Map<string, CanvasStore>();
const roomFor = (canvasId: string): CanvasStore => {
  const existing = rooms.get(canvasId);
  if (existing) return existing;
  const made = createStore([]);
  rooms.set(canvasId, made);
  return made;
};

/** The room opener seam, as #305's test uses it: one store per open, queueing until flush. */
const fakeOpener = async (canvasId: string): Promise<RemoteCanvasStore> => {
  const room = roomFor(canvasId);
  const mirror = createStore(room.getState().shapes);
  const queue: Array<() => void> = [];
  return {
    getState: () => mirror.getState(),
    upsert: (s) => (queue.push(() => room.upsert(s)), mirror.upsert(s)),
    remove: (ids) => (queue.push(() => room.remove(ids)), mirror.remove(ids)),
    clear: () => (queue.push(() => room.clear()), mirror.clear()),
    flush: async () => {
      for (const op of queue.splice(0)) op();
    },
  };
};

/** message → the store the bridge handed that turn (kept so a turn is observably done). */
const storeOf = new Map<string, TurnStore>();

// The fake runChat: draw a marker through the REAL create_shapes tool handler, so the
// commit-after-every-tool-call wrapper (#310) is part of what this exercises. A null
// sessionId keeps runChatTurn off the transcript-backup branch.
const fakeRunChat = async function* (store: TurnStore, message: string) {
  const create = createCanvasTools(store).find((t) => t.name === 'create_shapes')!;
  await create.handler({ shapes: [{ type: 'note', x: 0, y: 0, text: message }] } as never, undefined as never);
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

/** Did canvas `canvasId`'s ROOM end up with a note carrying this marker? */
const roomHas = (canvasId: string, marker: string): boolean =>
  roomFor(canvasId).getState().shapes.some((sh: CanvasShape) => sh.type === 'note' && sh.text === marker);

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('agent chat routes to the active canvas session (#79)', () => {
  let sub: ReadableStreamDefaultController;
  let restoreRunChat: () => void;
  beforeEach(() => {
    sub = fakeSubscriber(); // one subscriber = the /send guard passes
    chatHub.subscribe(sub);
    restoreRunChat = setTurnRunChat(fakeRunChat);
    setCanvasRoomOpener(fakeOpener);
  });
  afterEach(() => {
    restoreRunChat();
    setCanvasRoomOpener(null);
    chatHub.resetForTests();
    rooms.clear();
  });

  test('a turn sent with x-canvas-id=B draws in canvas B\'s room, not the default\'s', async () => {
    expect((await handleRequest(send('chat_b', 'canvasB', `onB-${RUN}`))).status).toBe(202);
    expect((await handleRequest(send('chat_d', null, `onD-${RUN}`))).status).toBe(202);

    await storeForTurn(`onB-${RUN}`);
    await storeForTurn(`onD-${RUN}`);
    expect(roomHas('canvasB', `onB-${RUN}`)).toBe(true);
    expect(roomHas('default', `onB-${RUN}`)).toBe(false);
    expect(roomHas('default', `onD-${RUN}`)).toBe(true);
  });

  test('per-canvas isolation: a turn on B leaves another canvas C untouched', async () => {
    expect((await handleRequest(send('chat_iso', 'canvasIsoB', `iso-${RUN}`))).status).toBe(202);
    expect((await handleRequest(send('chat_isoc', 'canvasIsoC', `isoC-${RUN}`))).status).toBe(202);

    await storeForTurn(`iso-${RUN}`);
    await storeForTurn(`isoC-${RUN}`);
    expect(roomHas('canvasIsoB', `iso-${RUN}`)).toBe(true);
    expect(roomHas('canvasIsoC', `iso-${RUN}`)).toBe(false);
  });

  test('no canvas selection resolves to the default canvas, the same one every time', async () => {
    expect((await handleRequest(send('chat_default', null, `noSel-${RUN}`))).status).toBe(202);
    expect((await handleRequest(send('chat_default2', null, `noSel2-${RUN}`))).status).toBe(202);

    await storeForTurn(`noSel-${RUN}`);
    await storeForTurn(`noSel2-${RUN}`);
    expect(roomHas('default', `noSel-${RUN}`)).toBe(true);
    expect(roomHas('default', `noSel2-${RUN}`)).toBe(true);
  });
});
