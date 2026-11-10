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

  test('deleting BOTH ends leaves the arrow alive and fully unbound', async () => {
    const r = room();
    const other: CanvasShape = { ...rect, id: 'shape:s', x: 100, y: 100 };
    const arrow: CanvasShape = { id: 'shape:a', type: 'arrow', x1: 31, y1: 42, x2: 100, y2: 100, color: 'black', text: 'both', startShapeId: 'shape:r', endShapeId: 'shape:s' };
    await applyMutation(r, { op: 'upsert', shapes: [rect, other, arrow] });
    expect((await applyMutation(r, { op: 'read' })).shapes.find((s) => s.id === 'shape:a')).toMatchObject({ startShapeId: 'shape:r', endShapeId: 'shape:s' });

    const after = await applyMutation(r, { op: 'remove', ids: ['shape:r', 'shape:s'] });

    // The decision (see canvas-mutate.ts): the arrow SURVIVES, unbound. We do not
    // cascade the delete onto it — that matches what tldraw's own editor does.
    const survivor = after.shapes.find((s) => s.id === 'shape:a');
    expect(survivor).toBeDefined();
    expect(survivor).not.toHaveProperty('startShapeId');
    expect(survivor).not.toHaveProperty('endShapeId');
    // ...and it is not a stub: the authored terminal coordinates were persisted underneath
    // the bindings, so unbinding restores them rather than collapsing the arrow.
    expect(survivor).toMatchObject({ text: 'both', x1: 31, y1: 42, x2: 100, y2: 100 });
    expect(r.getCurrentSnapshot().documents.some((d) => (d.state as { typeName: string }).typeName === 'binding')).toBe(false);
  });

  test('clear sweeps bound arrows and their bindings together', async () => {
    const r = room();
    const arrow: CanvasShape = { id: 'shape:a', type: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5, color: 'black', text: '', endShapeId: 'shape:r' };
    await applyMutation(r, { op: 'upsert', shapes: [rect, arrow] });
    expect((await applyMutation(r, { op: 'clear' })).shapes).toEqual([]);
    // `clear` doooms every shape, so both ends of every binding are gone — no binding
    // record may outlive the sweep, or the next client to load the room chokes on it.
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

// A canvas can hold more than one page (tldraw's "Move to page → New page", plus the
// restored page switcher). The agent's model gained a `page` field for it. The rule the
// whole feature rests on: ABSENT MEANS THE FIRST PAGE. Every canvas that has only one
// page — nearly all of them — therefore reads and writes exactly as it did before, which
// is why the round-trip tests above still assert bare equality.
describe('pages', () => {
  const secondPage = { id: 'page:two', typeName: 'page', name: 'Page 2', index: 'a2', meta: {} };
  const withSecondPage = async (r: ReturnType<typeof room>) => {
    await r.updateStore((ctx) => ctx.put(secondPage as never));
  };

  test('a shape on the only page reads back with no page field at all', async () => {
    const r = room();
    const after = await applyMutation(r, { op: 'upsert', shapes: [rect] });
    expect(after.shapes[0]).not.toHaveProperty('page');
  });

  test('a shape written with a page lands there and reads it back', async () => {
    const r = room();
    await withSecondPage(r);
    const after = await applyMutation(r, { op: 'upsert', shapes: [{ ...rect, page: 'page:two' }] });
    expect(after.shapes[0]?.page).toBe('page:two');
    // ...and it really is parented to that page in the room, not just labelled.
    const rec = r.getCurrentSnapshot().documents.find((d) => d.state.id === 'shape:r')?.state as { parentId: string };
    expect(rec.parentId).toBe('page:two');
  });

  test('every read names the canvas pages, in the order a human sees them', async () => {
    const r = room();
    await withSecondPage(r);
    const read = await applyMutation(r, { op: 'read' });
    // A `page` id is opaque and nothing else hands one out. Without this, an agent asked to
    // write to "page 2" has no way to learn what to name — and no way to know a canvas has
    // more than one page at all.
    expect(read.pages).toEqual([
      { id: 'page:page', name: 'Page 1' },
      { id: 'page:two', name: 'Page 2' },
    ]);
    expect(CanvasMutationResult.safeParse(read).success).toBe(true);
  });

  test('shapes on different pages come back distinguishable rather than flattened together', async () => {
    const r = room();
    await withSecondPage(r);
    await applyMutation(r, { op: 'upsert', shapes: [rect, { ...rect, id: 'shape:s', page: 'page:two' }] });
    const read = await applyMutation(r, { op: 'read' });
    expect(read.shapes.map((s) => [s.id, s.page])).toEqual([
      ['shape:r', undefined],
      ['shape:s', 'page:two'],
    ]);
  });

  test('a shape in a frame reports the frame as its parent and the frame\'s page as its page', async () => {
    const r = room();
    await withSecondPage(r);
    const frame: CanvasShape = { id: 'shape:f', type: 'frame', x: 0, y: 0, w: 200, h: 200, color: 'black', name: 'F', page: 'page:two' };
    await applyMutation(r, { op: 'upsert', shapes: [frame, { ...rect, parentId: 'shape:f' }] });
    const read = await applyMutation(r, { op: 'read' });
    // The child never named a page — it inherits one by living in a frame that has one.
    // Without walking up, a framed shape would silently report the default page.
    expect(read.shapes.find((s) => s.id === 'shape:r')).toMatchObject({ parentId: 'shape:f', page: 'page:two' });
  });

  test('a page that does not exist is refused, not silently written to the default page', async () => {
    const r = room();
    await expect(applyMutation(r, { op: 'upsert', shapes: [{ ...rect, page: 'page:ghost' }] })).rejects.toBeInstanceOf(
      MutationRejected,
    );
    expect((await applyMutation(r, { op: 'read' })).shapes).toEqual([]);
  });
});

// Guideline 7: the contract is the boundary, and a field the schema does not name is
// STRIPPED there — silently, and only in the process that crosses it. Every unit test
// above would still pass with `page` missing from the zod schema, because they call
// applyMutation directly. This is the one that would fail.
describe('the page survives the contract', () => {
  test('parsing an upsert keeps the page rather than stripping it', () => {
    const parsed = CanvasMutation.parse({ op: 'upsert', shapes: [{ ...rect, page: 'page:two' }] });
    expect(parsed.op === 'upsert' && parsed.shapes[0]?.page).toBe('page:two');
  });

  test('and a result carrying a paged shape parses back', () => {
    const parsed = CanvasMutationResult.parse({ version: 1, shapes: [{ ...rect, page: 'page:two' }] });
    expect(parsed.shapes[0]?.page).toBe('page:two');
  });
});
