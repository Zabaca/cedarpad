import { describe, expect, test } from 'bun:test';
import { InMemorySyncStorage, type RoomSnapshot } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import type { CanvasShape, CanvasState } from '../src/shapes.ts';
import { blobToRoomSnapshot, canvasRecords, expectedShapes, invalidRecords, snapshotToShapes } from './blob-to-snapshot.ts';
import { createCanvasSyncRoom } from './sync-room.ts';

/** Load a snapshot into a REAL room on the app schema, then read its snapshot back.
 *  NOTE: `loadSnapshot` does NOT validate — see `invalidRecords` and the first test in
 *  this file. This proves the records survive a real room and decode back unchanged;
 *  schema validity is a separate assertion, deliberately. */
function throughRoom(snapshot: RoomSnapshot): RoomSnapshot {
  const room = createCanvasSyncRoom({ storage: new InMemorySyncStorage<TLRecord>() });
  room.loadSnapshot(snapshot);
  const out = room.getCurrentSnapshot();
  room.close();
  return out;
}

const state = (shapes: CanvasShape[]): CanvasState => ({ version: 7, shapes });

/** blob -> snapshot -> real room -> blob. What `verify` compares. */
const roundTrip = (shapes: CanvasShape[], canvasId = 'cv_test'): CanvasShape[] =>
  snapshotToShapes(throughRoom(blobToRoomSnapshot(state(shapes), canvasId)));

describe('blobToRoomSnapshot', () => {
  // The load-bearing test. `TLSocketRoom.loadSnapshot()` does NOT validate records — it
  // writes them straight through — so a wrong default prop would be accepted at import and
  // only surface as a broken client later. `invalidRecords` is the check that catches it,
  // and this asserts every record we emit, of every type, passes the app's real schema.
  test('every record it emits validates against createCanvasTLSchema()', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:r', type: 'rectangle', x: 0, y: 0, w: 1, h: 1, color: 'blue', text: 'r' },
      { id: 'shape:e', type: 'ellipse', x: 0, y: 0, w: 1, h: 1, color: 'red', text: 'e' },
      { id: 'shape:t', type: 'text', x: 0, y: 0, color: 'green', text: 't' },
      { id: 'shape:n', type: 'note', x: 0, y: 0, color: 'black', text: 'n' },
      { id: 'shape:f', type: 'frame', x: 0, y: 0, w: 1, h: 1, name: 'f', color: 'black' },
      { id: 'shape:i', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'data:image/png;base64,AA==', alt: 'i', color: 'black' },
      { id: 'shape:m', type: 'embed', x: 0, y: 0, w: 1, h: 1, url: 'https://e.test/x', color: 'black' },
      { id: 'shape:c', type: 'component', x: 0, y: 0, w: 1, h: 1, module: 'M', data: { a: 1 }, rev: 1, color: 'black' },
      { id: 'shape:h', type: 'chat', x: 0, y: 0, w: 1, h: 1, title: 'h', color: 'black' },
      { id: 'shape:a', type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, color: 'black', text: 'a', startShapeId: 'shape:r' },
    ];
    expect(invalidRecords(blobToRoomSnapshot(state(shapes), 'cv_test'))).toEqual([]);
  });

  test('invalidRecords NAMES a bad record rather than passing it through', () => {
    const snapshot = blobToRoomSnapshot(state([{ id: 'shape:n', type: 'note', x: 0, y: 0, color: 'black', text: 'n' }]), 'cv_test');
    const shape = snapshot.documents.find((d) => d.state.typeName === 'shape');
    (shape as { state: { type: string } }).state.type = 'no-such-shape-type';
    expect(invalidRecords(snapshot)).toHaveLength(1);
    expect(invalidRecords(snapshot)[0]).toContain('shape:n');
  });

  test('an empty canvas becomes a loadable room with a document and one page', () => {
    const out = throughRoom(blobToRoomSnapshot(state([]), 'cv_test'));
    const types = out.documents.map((d) => d.state.typeName).sort();
    expect(types).toEqual(['document', 'page']);
    expect(snapshotToShapes(out)).toEqual([]);
  });

  test('the plain text shapes round-trip identically', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:r1', type: 'rectangle', x: 10, y: 20, w: 160, h: 100, color: 'blue', text: 'hello' },
      { id: 'shape:e1', type: 'ellipse', x: 1, y: 2, w: 40, h: 30, color: 'red', text: '' },
      { id: 'shape:t1', type: 'text', x: -5, y: 7, color: 'green', text: 'two\nlines' },
      { id: 'shape:n1', type: 'note', x: 0, y: 0, color: 'black', text: 'sticky' },
    ];
    expect(roundTrip(shapes)).toEqual(shapes);
  });

  test('a component keeps its data payload and status', () => {
    const shapes: CanvasShape[] = [
      {
        id: 'shape:c1',
        type: 'component',
        x: 100,
        y: 200,
        w: 480,
        h: 320,
        module: 'KpiCard',
        data: { title: 'Revenue', rows: [{ n: 1, s: 'a' }], nested: { deep: { ok: true } }, nul: null },
        rev: 4,
        color: 'black',
        status: { phase: 'ready' },
      },
      {
        id: 'shape:c2',
        type: 'component',
        x: 0,
        y: 0,
        w: 360,
        h: 260,
        module: 'Bare',
        data: {},
        rev: 0,
        color: 'black',
      },
    ];
    expect(roundTrip(shapes)).toEqual(shapes);
  });

  test('a chat card round-trips, with and without an attached chatId', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:h1', type: 'chat', x: 5, y: 6, w: 380, h: 460, title: 'Canvas-born', color: 'black' },
      { id: 'shape:h2', type: 'chat', x: 7, y: 8, w: 300, h: 400, title: 'Attached', chatId: 'conv_123', color: 'black' },
    ];
    expect(roundTrip(shapes)).toEqual(shapes);
  });

  test('a free arrow keeps its terminals; a bound arrow keeps its bindings', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:a', type: 'rectangle', x: 0, y: 0, w: 10, h: 10, color: 'black', text: '' },
      { id: 'shape:b', type: 'rectangle', x: 500, y: 500, w: 10, h: 10, color: 'black', text: '' },
      { id: 'shape:free', type: 'arrow', x1: 1, y1: 2, x2: 3, y2: 4, color: 'red', text: 'label' },
      {
        id: 'shape:bound',
        type: 'arrow',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        color: 'black',
        text: '',
        startShapeId: 'shape:a',
        endShapeId: 'shape:b',
      },
      // Only one end bound: the free end keeps its coordinates.
      { id: 'shape:half', type: 'arrow', x1: 0, y1: 0, x2: 40, y2: 50, color: 'black', text: '', startShapeId: 'shape:a' },
    ];
    expect(roundTrip(shapes)).toEqual(shapes);
  });

  // An arrow with a bound terminal stores {0,0} for that terminal — the binding, not the
  // coordinate, is the truth. If the target is gone the coordinate is meaningless, so
  // migrating the arrow would draw a line to the origin: visibly WRONG, and it reads as a
  // rendering bug. A missing arrow at least reads as missing. So the whole arrow goes.
  test('an arrow with a dangling binding is DROPPED ENTIRELY, not migrated to the origin', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:keep', type: 'note', x: 0, y: 0, color: 'black', text: 'k' },
      { id: 'shape:x', type: 'arrow', x1: 0, y1: 0, x2: 9, y2: 9, color: 'black', text: '', endShapeId: 'shape:gone' },
    ];

    expect(canvasRecords(state(shapes), 'cv_test').dangling).toEqual([
      { arrowId: 'shape:x', terminal: 'end', toId: 'shape:gone' },
    ]);
    expect(roundTrip(shapes)).toEqual([shapes[0] as CanvasShape]);
    // `verify` diffs against this, so the known loss is named at dump time, not reported
    // as an anonymous mismatch later.
    expect(expectedShapes(state(shapes), 'cv_test')).toEqual([shapes[0]]);
  });

  test('an arrow whose bindings all resolve is kept, even alongside a dangling one', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:a', type: 'note', x: 0, y: 0, color: 'black', text: 'a' },
      { id: 'shape:b', type: 'note', x: 9, y: 9, color: 'black', text: 'b' },
      { id: 'shape:ok', type: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0, color: 'black', text: '', startShapeId: 'shape:a', endShapeId: 'shape:b' },
      { id: 'shape:bad', type: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0, color: 'black', text: '', startShapeId: 'shape:missing' },
    ];
    expect(roundTrip(shapes).map((s) => s.id)).toEqual(['shape:a', 'shape:b', 'shape:ok']);
  });

  test('expectedShapes normalizes exactly the known losses, and nothing else', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:d', type: 'draw', color: 'black', points: [[0, 0]] },
      { id: 'shape:n', type: 'note', x: 0, y: 0, color: 'blue', text: 'kept', parentId: 'shape:nowhere' },
      { id: 'shape:f', type: 'frame', x: 0, y: 0, w: 10, h: 10, name: 'f', color: 'black' },
      { id: 'shape:c', type: 'note', x: 1, y: 1, color: 'blue', text: 'child', parentId: 'shape:f' },
    ];
    expect(expectedShapes(state(shapes), 'cv_test')).toEqual([
      { id: 'shape:n', type: 'note', x: 0, y: 0, color: 'blue', text: 'kept' },
      { id: 'shape:f', type: 'frame', x: 0, y: 0, w: 10, h: 10, name: 'f', color: 'black' },
      { id: 'shape:c', type: 'note', x: 1, y: 1, color: 'blue', text: 'child', parentId: 'shape:f' },
    ]);
  });

  test('a frame keeps its children, and their parent-relative coordinates', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:f1', type: 'frame', x: 10, y: 10, w: 400, h: 300, name: 'Group A', color: 'black' },
      { id: 'shape:in', type: 'note', x: 5, y: 5, color: 'blue', text: 'inside', parentId: 'shape:f1' },
      // A child whose frame is not in this canvas: reparented to the page rather than dangled.
      { id: 'shape:orphan', type: 'note', x: 1, y: 1, color: 'blue', text: 'orphan', parentId: 'shape:missing' },
    ];
    const out = roundTrip(shapes);
    expect(out.slice(0, 2)).toEqual(shapes.slice(0, 2));
    expect(out[2]).toEqual({ id: 'shape:orphan', type: 'note', x: 1, y: 1, color: 'blue', text: 'orphan' });
  });

  // #290 moved canvas image bytes OUT of the record and into R2, because a base64 data
  // URL in a record is persisted to DO SQLite and shipped to every client on load — "the
  // exact cost the migration exists to remove" (worker/canvas-assets.ts). A migration that
  // re-inlined them would undo that on day one, so the blob's data URL is externalised.
  test('an image is EXTERNALISED to R2, not inlined as a data URL', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    const shapes: CanvasShape[] = [
      { id: 'shape:i1', type: 'image', x: 3, y: 4, w: 200, h: 150, src, alt: 'a screenshot', color: 'black' },
    ];

    const { assets, records } = canvasRecords(state(shapes), 'cv_1');

    expect(assets).toEqual([{ key: 'i1.png', contentType: 'image/png', base64: 'iVBORw0KGgo=' }]);
    const asset = records.find((r) => r.typeName === 'asset') as unknown as { props: { src: string } };
    expect(asset.props.src).toBe('/api/canvas-assets/cv_1/i1.png');
    // Nothing base64 survives into the document.
    expect(JSON.stringify(records)).not.toContain('iVBORw0KGgo=');
  });

  test('the externalised url is what verify expects back, so images stay strictly checked', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:i1', type: 'image', x: 3, y: 4, w: 200, h: 150, src: 'data:image/png;base64,AA==', alt: 'a', color: 'black' },
    ];
    const url = '/api/canvas-assets/cv_1/i1.png';
    expect(roundTrip(shapes, 'cv_1')).toEqual([{ ...shapes[0], src: url } as CanvasShape]);
    expect(expectedShapes(state(shapes), 'cv_1')).toEqual([{ ...shapes[0], src: url } as CanvasShape]);
  });

  test('an image already on the R2 plane is passed through, not re-uploaded', () => {
    const src = '/api/canvas-assets/cv_1/abc-shot.png';
    const shapes: CanvasShape[] = [
      { id: 'shape:i1', type: 'image', x: 0, y: 0, w: 10, h: 10, src, alt: '', color: 'black' },
    ];
    expect(canvasRecords(state(shapes), 'cv_1').assets).toEqual([]);
    expect(roundTrip(shapes, 'cv_1')).toEqual(shapes);
  });

  test('an embed round-trips', () => {
    const shapes: CanvasShape[] = [
      { id: 'shape:v1', type: 'embed', x: 0, y: 0, w: 480, h: 270, url: 'https://youtu.be/x', color: 'black' },
    ];
    expect(roundTrip(shapes)).toEqual(shapes);
  });

  test('freehand `draw` shapes are DROPPED, and reported — never silently lost', () => {
    const drawn: CanvasShape = { id: 'shape:d1', type: 'draw', color: 'black', points: [[0, 0], [1, 1]] };
    const kept: CanvasShape = { id: 'shape:k', type: 'note', x: 0, y: 0, color: 'black', text: 'k' };
    const { dropped } = canvasRecords(state([drawn, kept]), 'cv_test');
    expect(dropped).toEqual([drawn]);
    expect(roundTrip([drawn, kept])).toEqual([kept]);
  });

  test('order survives past the 62 single-character index keys', () => {
    const shapes: CanvasShape[] = Array.from({ length: 150 }, (_, i) => ({
      id: `shape:s${i}`,
      type: 'note' as const,
      x: i,
      y: 0,
      color: 'black' as const,
      text: `n${i}`,
    }));
    expect(roundTrip(shapes).map((s) => s.id)).toEqual(shapes.map((s) => s.id));
  });
});

// The migration's twin of the same defect (see src/tl-record-builder.test.ts). tldraw
// draws a note's label at `(fontSizeAdjustment ?? 1) * labelFontSize`; `0 ?? 1` is 0, so
// a 0 here migrated every sticky note's text to 0px — intact in the record, invisible on
// the board. The blobs and the loaded snapshots always held the right text, which is why
// `verify` (a shape-model comparison) reported a clean cutover.
describe('migrated notes render their text at a visible size', () => {
  test('a migrated note carries a non-zero fontSizeAdjustment multiplier', () => {
    const snap = blobToRoomSnapshot(
      { version: 1, shapes: [{ id: 'shape:n', type: 'note', x: 0, y: 0, text: 'hello' }] } as never,
      'cv_test',
    );
    const note = snap.documents
      .map((d) => d.state as unknown as { type?: string; props: Record<string, unknown> })
      .find((r) => r.type === 'note');
    expect(note).toBeDefined();
    expect(note.props.fontSizeAdjustment).toBeGreaterThan(0);
  });
});
