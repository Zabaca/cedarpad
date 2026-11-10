// #310: the chat agent's canvas store for one turn — a room-backed store with an explicit
// commit point after every tool call.

import { describe, expect, test } from 'bun:test';

import { openTurnCanvasStore } from './turn-canvas-store.ts';
import { createStore } from '../src/store.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';

/** A fake room: `room` is the authoritative state; a store's queued mutations only reach it
 *  on flush, exactly like `openRemoteCanvasStore`. */
function fakeRoom(opts: { flushFails?: string; failOnce?: boolean; openFails?: string } = {}) {
  const room = createStore([]);
  let flushes = 0;
  let opens = 0;
  let failing = opts.flushFails;
  const open = async (): Promise<RemoteCanvasStore> => {
    opens += 1;
    if (opts.openFails) throw new Error(opts.openFails);
    // The mirror: a snapshot of the room at open time, plus a queue.
    const mirror = createStore(room.getState().shapes);
    const queue: Array<() => void> = [];
    let poison: Error | null = null;
    const live = <T>(fn: () => T): T => {
      if (poison) throw poison;
      return fn();
    };
    return {
      getState: () => live(() => mirror.getState()),
      upsert: (s) => live(() => (queue.push(() => room.upsert(s)), mirror.upsert(s))),
      remove: (ids) => live(() => (queue.push(() => room.remove(ids)), mirror.remove(ids))),
      clear: () => live(() => (queue.push(() => room.clear()), mirror.clear())),
      flush: async () => {
        flushes += 1;
        if (failing) {
          poison = new Error(failing);
          if (opts.failOnce) failing = undefined;
          throw poison;
        }
        for (const op of queue.splice(0)) op();
      },
    };
  };
  return { room, open, flushes: () => flushes, opens: () => opens };
}

describe('openTurnCanvasStore', () => {
  test('commit sends the turn-so-far to the room', async () => {
    const { room, open } = fakeRoom();
    const store = await openTurnCanvasStore(open);

    store.upsert([{ id: 'shape:a', type: 'note', color: 'black', x: 0, y: 0, text: 'drawn mid-turn' }]);
    expect(room.getState().shapes).toHaveLength(0); // not yet — the room is the authority

    await store.commit();
    expect(room.getState().shapes.map((s) => s.id)).toEqual(['shape:a']);
  });

  test('a failed commit rejects with the room\'s own reason', async () => {
    const { open } = fakeRoom({ flushFails: 'room said no' });
    const store = await openTurnCanvasStore(open);

    store.upsert([{ id: 'shape:a', type: 'note', color: 'black', x: 0, y: 0, text: 'doomed' }]);
    expect(store.commit()).rejects.toThrow('room said no');
  });

  test('a failed commit does not poison the rest of the turn — the next tool call gets a fresh store', async () => {
    const { room, open } = fakeRoom({ flushFails: 'transient', failOnce: true });
    const store = await openTurnCanvasStore(open);

    store.upsert([{ id: 'shape:a', type: 'note', color: 'black', x: 0, y: 0, text: 'lost' }]);
    await expect(store.commit()).rejects.toThrow('transient');

    // The poisoned store was reopened, so this does not throw the poison.
    store.upsert([{ id: 'shape:b', type: 'note', color: 'black', x: 0, y: 0, text: 'landed' }]);
    await store.commit();
    expect(room.getState().shapes.map((s) => s.id)).toEqual(['shape:b']);
  });

  test('discard drops what a refused tool queued', async () => {
    const { room, open } = fakeRoom();
    const store = await openTurnCanvasStore(open);

    store.upsert([{ id: 'shape:a', type: 'note', color: 'black', x: 0, y: 0, text: 'refused' }]);
    await store.discard();
    store.upsert([{ id: 'shape:b', type: 'note', color: 'black', x: 0, y: 0, text: 'kept' }]);
    await store.commit();

    expect(room.getState().shapes.map((s) => s.id)).toEqual(['shape:b']);
  });

  test('each settle reopens, so the next tool call reads the room (a human edit mid-turn is visible)', async () => {
    const { room, open } = fakeRoom();
    const store = await openTurnCanvasStore(open);

    room.upsert([{ id: 'shape:human', type: 'note', color: 'black', x: 0, y: 0, text: 'drawn by the human' }]);
    expect(store.getState().shapes).toHaveLength(0); // the open-time snapshot

    await store.commit();
    expect(store.getState().shapes.map((s) => s.id)).toEqual(['shape:human']);
  });
});
