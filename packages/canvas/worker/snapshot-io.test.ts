import { describe, expect, test } from 'bun:test';
import { InMemorySyncStorage } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import type { CanvasShape } from '../src/shapes.ts';
import { blobToRoomSnapshot, snapshotToShapes } from './blob-to-snapshot.ts';
import { handleSnapshotRequest } from './snapshot-io.ts';
import { createCanvasSyncRoom } from './sync-room.ts';

const note = (id: string, text: string): CanvasShape => ({ id, type: 'note', x: 0, y: 0, color: 'black', text });

const emptyRoom = () => createCanvasSyncRoom({ storage: new InMemorySyncStorage<TLRecord>() });

const post = (body: unknown, query = '') =>
  new Request(`https://app.cedarpad.com/api/canvas-sync/c1/snapshot${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

const get = () => new Request('https://app.cedarpad.com/api/canvas-sync/c1/snapshot');

describe('handleSnapshotRequest', () => {
  test('imports a snapshot into an empty room and reports the shape count', async () => {
    const room = emptyRoom();
    const snapshot = blobToRoomSnapshot({ version: 1, shapes: [note('shape:a', 'one'), note('shape:b', 'two')] });

    const res = await handleSnapshotRequest(room, post(snapshot));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 2 });
    expect(snapshotToShapes(room.getCurrentSnapshot()).map((s) => s.id)).toEqual(['shape:a', 'shape:b']);
    room.close();
  });

  test('REFUSES a room that already has shapes, and leaves it untouched', async () => {
    const room = emptyRoom();
    await handleSnapshotRequest(room, post(blobToRoomSnapshot({ version: 1, shapes: [note('shape:a', 'one')] })));

    const res = await handleSnapshotRequest(room, post(blobToRoomSnapshot({ version: 2, shapes: [note('shape:z', 'z')] })));

    expect(res.status).toBe(409);
    expect(snapshotToShapes(room.getCurrentSnapshot()).map((s) => s.id)).toEqual(['shape:a']);
    room.close();
  });

  test('?force=1 replaces a non-empty room wholesale', async () => {
    const room = emptyRoom();
    await handleSnapshotRequest(room, post(blobToRoomSnapshot({ version: 1, shapes: [note('shape:a', 'one')] })));

    const res = await handleSnapshotRequest(
      room,
      post(blobToRoomSnapshot({ version: 2, shapes: [note('shape:z', 'z')] }), '?force=1'),
    );

    expect(res.status).toBe(200);
    expect(snapshotToShapes(room.getCurrentSnapshot()).map((s) => s.id)).toEqual(['shape:z']);
    room.close();
  });

  test('GET exports the room snapshot, so `verify` can read what actually landed', async () => {
    const room = emptyRoom();
    await handleSnapshotRequest(room, post(blobToRoomSnapshot({ version: 1, shapes: [note('shape:a', 'one')] })));

    const res = await handleSnapshotRequest(room, get());

    expect(res.status).toBe(200);
    expect(snapshotToShapes((await res.json()) as never)).toEqual([note('shape:a', 'one')]);
    room.close();
  });

  test('rejects a body that is not a room snapshot rather than wedging the room', async () => {
    const room = emptyRoom();
    const res = await handleSnapshotRequest(room, post({ nope: true }));
    expect(res.status).toBe(400);
    expect(snapshotToShapes(room.getCurrentSnapshot())).toEqual([]);
    room.close();
  });

  test('a snapshot shaped right but holding INVALID records is refused, not half-applied', async () => {
    const room = emptyRoom();
    await handleSnapshotRequest(room, post(blobToRoomSnapshot({ version: 1, shapes: [note('shape:a', 'one')] })));

    // A real snapshot, with one record corrupted: it passes `isRoomSnapshot` (the shape of
    // the envelope is fine) but is not a valid tldraw record. Only tldraw can decide that,
    // so the failure surfaces from `loadSnapshot` — which throws SYNCHRONOUSLY, unlike
    // `room.updateStore()`, whose rejection a plain try/catch would miss (#291).
    const corrupt = blobToRoomSnapshot({ version: 2, shapes: [note('shape:z', 'z')] });
    const shape = corrupt.documents.find((d) => d.state.typeName === 'shape');
    (shape as { state: { type: string } }).state.type = 'no-such-shape-type';

    const res = await handleSnapshotRequest(room, post(corrupt, '?force=1'));

    expect(res.status).toBe(400);
    // The room is transactional, so the pre-existing document is still intact.
    expect(snapshotToShapes(room.getCurrentSnapshot()).map((s) => s.id)).toEqual(['shape:a']);
    room.close();
  });
});
