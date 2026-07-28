import { describe, expect, test } from 'bun:test';

import { CanvasMutation, type CanvasMutationResult } from '../shared/canvas-mutation';
import { createShapesOp, deleteShapesOp } from './canvas-ops';
import { openRemoteCanvasStore } from './remote-store';
import type { CanvasShape } from './shapes';

const rect: CanvasShape = { id: 'shape:r', type: 'rectangle', x: 1, y: 2, w: 30, h: 40, color: 'blue', text: 'hi' };

/** A stand-in room: it parses the contract (both ends, one schema) and keeps a map. */
function fakeRoom(seed: CanvasShape[] = []) {
  const shapes = new Map(seed.map((s) => [s.id, s]));
  const sent: CanvasMutation[] = [];
  let version = 0;
  const post = async (_url: string, init: { body: string }): Promise<Response> => {
    const m = CanvasMutation.parse(JSON.parse(init.body));
    sent.push(m);
    if (m.op === 'upsert') for (const s of m.shapes) shapes.set(s.id, s);
    if (m.op === 'remove') for (const id of m.ids) shapes.delete(id);
    if (m.op === 'clear') shapes.clear();
    if (m.op !== 'read') version += 1;
    const body: CanvasMutationResult = { version, shapes: [...shapes.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { post: post as unknown as typeof fetch, sent };
}

describe('openRemoteCanvasStore', () => {
  test('opens on the room’s current state', async () => {
    const room = fakeRoom([rect]);
    const store = await openRemoteCanvasStore('/api/canvas-sync/c1/mutate', room.post);
    expect(store.getState().shapes).toEqual([rect]);
    expect(room.sent).toEqual([{ op: 'read' }]);
  });

  test('the existing agent ops run against it unchanged, and flush lands them on the room', async () => {
    const room = fakeRoom();
    const store = await openRemoteCanvasStore('/api/canvas-sync/c1/mutate', room.post);
    // canvas-ops.ts is untouched by this slice: it sees an ordinary synchronous
    // CanvasStore. That is the whole point of the seam (ADR-0019).
    const res = createShapesOp(store, [{ type: 'note', x: 5, y: 6, text: 'hello' }]);
    expect(res.isError).toBeFalsy();
    await store.flush();
    expect(room.sent[1]?.op).toBe('upsert');
    expect(store.getState().shapes).toHaveLength(1);
    expect(store.getState().shapes[0]).toMatchObject({ type: 'note', text: 'hello' });
  });

  test('a delete flushes as a remove, in the order the ops ran', async () => {
    const room = fakeRoom([rect]);
    const store = await openRemoteCanvasStore('/api/canvas-sync/c1/mutate', room.post);
    createShapesOp(store, [{ type: 'note', x: 0, y: 0, text: 'n' }]);
    deleteShapesOp(store, [rect.id]);
    await store.flush();
    expect(room.sent.map((m) => m.op)).toEqual(['read', 'upsert', 'remove']);
    expect(store.getState().shapes.map((s) => s.type)).toEqual(['note']);
  });

  test('a rejected write surfaces the room’s reason', async () => {
    const store = await openRemoteCanvasStore('/api/canvas-sync/c1/mutate', (async () =>
      new Response(JSON.stringify({ error: 'tldraw rejected the record: bad id' }), { status: 400 })) as unknown as typeof fetch).catch(
      (e: Error) => e,
    );
    expect(store).toBeInstanceOf(Error);
    expect((store as Error).message).toContain('bad id');
  });
});
