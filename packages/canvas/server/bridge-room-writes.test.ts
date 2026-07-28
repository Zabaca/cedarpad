// #305: the bridge's canvas handlers write to the Durable-Object-hosted ROOM, not to the
// in-memory session store nobody reads any more (since #290 the browser syncs from the room).
//
// The seam is `setCanvasRoomOpener`: the handler asks for a store per call, so a fake opener
// here is exactly the shape production uses (`canvasRoomOpener` → `openRemoteCanvasStore`).

import { afterEach, describe, expect, test } from 'bun:test';

import { handleRequest, setCanvasRoomOpener } from './bridge.ts';
import { createStore } from '../src/store.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';

/** A room store that records flushes, optionally failing them (the poison case). */
function fakeRoom(opts: { flushFails?: string } = {}) {
  const inner = createStore([]);
  let flushes = 0;
  const store: RemoteCanvasStore = {
    getState: () => inner.getState(),
    upsert: (s) => inner.upsert(s),
    remove: (ids) => inner.remove(ids),
    clear: () => inner.clear(),
    flush: async () => {
      flushes += 1;
      if (opts.flushFails) throw new Error(opts.flushFails);
    },
  };
  const opened: string[] = [];
  setCanvasRoomOpener(async (canvasId) => {
    opened.push(canvasId);
    return store;
  });
  return { store, opened, flushes: () => flushes };
}

const post = (path: string, body: unknown, canvasId = 'room-canvas') =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-canvas-id': canvasId },
    body: JSON.stringify(body),
  });

afterEach(() => setCanvasRoomOpener(null));

describe('bridge canvas writes go to the room', () => {
  test('create_shapes lands in the room store and is flushed before the 200', async () => {
    const room = fakeRoom();
    const res = await handleRequest(
      post('/api/canvas/shapes/create', { shapes: [{ type: 'note', x: 1, y: 2, text: 'hello room' }] }),
    );

    expect(res.status).toBe(200);
    expect(room.opened).toEqual(['room-canvas']);
    expect(room.store.getState().shapes.map((s) => s.type)).toEqual(['note']);
    expect(room.flushes()).toBe(1);
  });

  test('a flush failure is an error, never a silent success', async () => {
    const room = fakeRoom({ flushFails: 'room said no' });
    const res = await handleRequest(
      post('/api/canvas/shapes/create', { shapes: [{ type: 'note', x: 1, y: 2, text: 'doomed' }] }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('room said no') });
    expect(room.flushes()).toBe(1);
  });

  test('GET /api/canvas reads the room, not the session store', async () => {
    const room = fakeRoom();
    room.store.upsert([{ id: 'shape:from-room', type: 'note', color: 'black', x: 0, y: 0, text: 'only in the room' }]);

    const res = await handleRequest(new Request('http://localhost/api/canvas', { headers: { 'x-canvas-id': 'room-canvas' } }));
    expect(await res.json()).toMatchObject({ shapes: [{ id: 'shape:from-room' }] });
  });

  test('place_component, update_shapes and delete all write to the room', async () => {
    const room = fakeRoom();
    await handleRequest(post('/api/components/place', { module: 'Thing', x: 0, y: 0, w: 100, h: 100 }));
    const placed = room.store.getState().shapes;
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ type: 'component', module: 'Thing' });

    await handleRequest(post('/api/canvas/shapes/update', { shapes: [{ id: placed[0]!.id, x: 55 }] }));
    expect(room.store.getState().shapes[0]).toMatchObject({ x: 55 });

    await handleRequest(post('/api/canvas/delete', { ids: [placed[0]!.id] }));
    expect(room.store.getState().shapes).toHaveLength(0);
    expect(room.flushes()).toBe(3);
  });
});
