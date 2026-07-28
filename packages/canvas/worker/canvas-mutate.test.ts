import { describe, expect, test } from 'bun:test';

import { CanvasMutation, CanvasMutationResult } from '../shared/canvas-mutation.ts';
import type { CanvasShape } from '../src/shapes.ts';
import { applyMutation, MutationRejected } from './canvas-mutate.ts';
import { createCanvasSyncRoom } from './sync-room.ts';

const rect: CanvasShape = { id: 'shape:r', type: 'rectangle', x: 1, y: 2, w: 30, h: 40, color: 'blue', text: 'hi' };
const room = () => createCanvasSyncRoom();

describe('applyMutation', () => {
  test('upsert then read round-trips the simplified shape through the room', async () => {
    const r = room();
    const after = await applyMutation(r, { op: 'upsert', shapes: [rect] });
    expect(after.shapes).toEqual([rect]);
    // The result parses as the contract on the caller's side too — both ends, one schema.
    expect(CanvasMutationResult.safeParse(after).success).toBe(true);
    const read = await applyMutation(r, { op: 'read' });
    expect(read.shapes).toEqual([rect]);
    expect(read.version).toBeGreaterThan(0);
  });

  test('remove and clear drop shapes', async () => {
    const r = room();
    await applyMutation(r, { op: 'upsert', shapes: [rect, { ...rect, id: 'shape:s' }] });
    expect((await applyMutation(r, { op: 'remove', ids: ['shape:r'] })).shapes.map((s) => s.id)).toEqual(['shape:s']);
    expect((await applyMutation(r, { op: 'clear' })).shapes).toEqual([]);
  });

  test('deleting a bound shape takes its arrow binding with it', async () => {
    const r = room();
    const arrow: CanvasShape = { id: 'shape:a', type: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5, color: 'black', text: '', endShapeId: 'shape:r' };
    await applyMutation(r, { op: 'upsert', shapes: [rect, arrow] });
    expect((await applyMutation(r, { op: 'read' })).shapes.find((s) => s.id === 'shape:a')).toMatchObject({ endShapeId: 'shape:r' });
    await applyMutation(r, { op: 'remove', ids: ['shape:r'] });
    // A binding whose target is gone is what breaks every client that loads the room —
    // sync-core has no binding logic, so this cascade is ours.
    expect(r.getCurrentSnapshot().documents.some((d) => (d.state as { typeName: string }).typeName === 'binding')).toBe(false);
  });
});

describe('the contract', () => {
  test('rejects a malformed agent payload before any record is built', () => {
    const parsed = CanvasMutation.safeParse({ op: 'upsert', shapes: [{ ...rect, w: 'wide' }] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.path.includes('w'))).toBe(true);
  });
});

describe('the room, not the contract, is the last line of defence', () => {
  test('a record tldraw itself rejects is not persisted', async () => {
    const r = room();
    // Contract-valid, record-invalid: the contract only asks for a non-empty id, but
    // tldraw requires the `shape:` prefix. `put()` calls `recordType.validate` and throws
    // — which is exactly why this path uses `updateStore`, not a raw `storage.transaction`
    // write that would have persisted it (ADR-0019, "The write API").
    const bogus = { ...rect, id: 'nope' } as CanvasShape;
    await expect(applyMutation(r, { op: 'upsert', shapes: [bogus] })).rejects.toBeInstanceOf(MutationRejected);
    expect((await applyMutation(r, { op: 'read' })).shapes).toEqual([]);
  });
});
