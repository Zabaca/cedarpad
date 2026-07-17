// Unit tests for the PURE reconcile planner. No tldraw runtime, no DOM, no jsdom:
// fixtures are plain object literals built inline per test. Each test asserts one
// invariant of `planReconcile` ported from today's `reconcile()`.

import { describe, expect, test } from 'bun:test';
import type { TLAsset, TLShape } from 'tldraw';

import type { CanvasShape, CanvasState } from './shapes';
import { canon, imageAssetId } from './tldraw-conventions';
import {
  type EditorSnapshot,
  type ReconcileInput,
  type ReconcileOp,
  planReconcile,
} from './sync-plan';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

const tlasset = (assetId: string, src: string, w = 100, h = 100): TLAsset =>
  ({
    id: assetId,
    typeName: 'asset',
    type: 'image',
    meta: {},
    props: { w, h, name: 'image', isAnimated: false, mimeType: 'image/png', src },
  }) as unknown as TLAsset;

// A present shape's value carries only what the planner reads back off the live store
// today: presence + `parentId` (the reparent-convergence check). A bare marker is fine
// for shapes whose parent doesn't matter to the test.
const present = (parentId?: string): TLShape => (parentId ? { parentId } : {}) as unknown as TLShape;

const rect = (id: string, x: number, over: Partial<CanvasShape> = {}): CanvasShape =>
  ({ id, type: 'rectangle', x, y: 0, w: 100, h: 100, color: 'black', text: '', ...over }) as CanvasShape;

const image = (id: string, src: string): CanvasShape =>
  ({ id, type: 'image', x: 0, y: 0, w: 100, h: 100, src, alt: '', color: 'black' }) as CanvasShape;

const arrow = (id: string, over: Partial<CanvasShape> = {}): CanvasShape =>
  ({ id, type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10, color: 'black', text: '', ...over }) as CanvasShape;

function snap(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    shapes: new Map(),
    assets: new Map(),
    arrowBindings: new Map(),
    editingId: null,
    interacting: false,
    selectedIds: new Set(),
    canonical: new Map(),
    ...over,
  };
}

function input(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    remote: { version: 1, shapes: [] } as CanvasState,
    lastVersion: 0,
    snapshot: snap(),
    mirroredShapes: new Set(),
    ...over,
  };
}

const opOf = <K extends ReconcileOp['kind']>(ops: ReconcileOp[], kind: K): Extract<ReconcileOp, { kind: K }> | undefined =>
  ops.find((o) => o.kind === kind) as Extract<ReconcileOp, { kind: K }> | undefined;

const ids = (partials: Array<{ id: unknown }>): string[] => partials.map((p) => String(p.id));

// The delete/remove ops carry branded id arrays (TLShapeId/TLBindingId), which
// are plain strings at runtime; compare them as strings so the literal expecteds type-check.
const idsOf = (op?: { ids: readonly string[] }): string[] | undefined => (op ? [...op.ids] : undefined);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Version gate
// ─────────────────────────────────────────────────────────────────────────────

test('1. version gate: remote.version <= lastVersion yields an empty plan', () => {
  const plan = planReconcile(
    input({
      lastVersion: 5,
      // A would-be create that must be short-circuited by the gate.
      remote: { version: 5, shapes: [rect('shape:a', 0)] },
    }),
  );
  expect(plan.ops).toEqual([]);
  expect(plan.nextVersion).toBe(5);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Mid-drag hold (interacting + selected)
// ─────────────────────────────────────────────────────────────────────────────

test('2. mid-drag hold: a selected shape while interacting gets no update/delete; others reconcile', () => {
  const aCur = rect('shape:a', 0);
  const bCur = rect('shape:b', 0);
  const plan = planReconcile(
    input({
      remote: {
        version: 2,
        // Both changed (moved); plus c absent so it would delete if mirrored.
        shapes: [rect('shape:a', 50), rect('shape:b', 50)],
      },
      mirroredShapes: new Set(['shape:a', 'shape:b', 'shape:c']),
      snapshot: snap({
        shapes: new Map([
          ['shape:a', present()],
          ['shape:b', present()],
          ['shape:c', present()],
        ]),
        canonical: new Map([
          ['shape:a', canon(aCur)],
          ['shape:b', canon(bCur)],
        ]),
        interacting: true,
        selectedIds: new Set(['shape:a', 'shape:c']),
      }),
    }),
  );
  // a is held -> no update for it; b updates normally.
  expect(ids(opOf(plan.ops, 'shapeUpdate')?.partials ?? [])).toEqual(['shape:b']);
  // c is held (selected while interacting) -> not deleted despite being mirrored+absent.
  expect(opOf(plan.ops, 'shapeDelete')).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Editing-shape hold
// ─────────────────────────────────────────────────────────────────────────────

test('3. editing hold: the text-edited shape gets no update/delete; others reconcile', () => {
  const eCur = rect('shape:e', 0);
  const bCur = rect('shape:b', 0);
  const plan = planReconcile(
    input({
      remote: { version: 2, shapes: [rect('shape:e', 50), rect('shape:b', 50)] },
      mirroredShapes: new Set(['shape:e', 'shape:b']),
      snapshot: snap({
        shapes: new Map([
          ['shape:e', present()],
          ['shape:b', present()],
        ]),
        canonical: new Map([
          ['shape:e', canon(eCur)],
          ['shape:b', canon(bCur)],
        ]),
        // Editing is a form of interacting (the real extractor sets both).
        interacting: true,
        editingId: 'shape:e',
      }),
    }),
  );
  expect(ids(opOf(plan.ops, 'shapeUpdate')?.partials ?? [])).toEqual(['shape:b']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Top-level create carries no parent
// ─────────────────────────────────────────────────────────────────────────────

test('4. a top-level remote shape is created with no parentId (tldraw parents it to the canvas)', () => {
  const plan = planReconcile(input({ remote: { version: 1, shapes: [rect('shape:x', 0)] } }));
  const create = opOf(plan.ops, 'shapeCreate');
  expect(create?.partials).toHaveLength(1);
  expect((create!.partials[0] as { parentId?: string }).parentId).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Parent-first ordering
// ─────────────────────────────────────────────────────────────────────────────

test('5. parent-first ordering: a frame is created before a child that arrives first', () => {
  const child = rect('shape:c', 0, { parentId: 'shape:f' });
  const frame = { id: 'shape:f', type: 'frame', x: 0, y: 0, w: 300, h: 300, name: 'F', color: 'black' } as CanvasShape;
  const plan = planReconcile(
    input({
      // Child appears BEFORE its frame in the remote list.
      remote: { version: 1, shapes: [child, frame] },
    }),
  );
  expect(ids(opOf(plan.ops, 'shapeCreate')!.partials)).toEqual(['shape:f', 'shape:c']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Update without reparent
// ─────────────────────────────────────────────────────────────────────────────

test('6. update without reparent: an existing frame child updates with no parentId', () => {
  const cur = rect('shape:u', 0, { parentId: 'shape:f' });
  const plan = planReconcile(
    input({
      remote: { version: 2, shapes: [rect('shape:u', 50, { parentId: 'shape:f' })] },
      snapshot: snap({
        shapes: new Map([['shape:u', present('shape:f')], ['shape:f', present()]]),
        canonical: new Map([['shape:u', canon(cur)]]),
      }),
    }),
  );
  const update = opOf(plan.ops, 'shapeUpdate');
  expect(update?.partials).toHaveLength(1);
  expect('parentId' in (update!.partials[0] as object)).toBe(false);
});

test('6b. reparent convergence: a page-parented local shape whose remote frame exists updates WITH parentId', () => {
  // The hydrate race: the child was created before its frame and tldraw page-parented it.
  // Once the frame exists locally, the update carries the model parentId to converge.
  const cur = rect('shape:u', 0); // local decodes with NO parentId
  const plan = planReconcile(
    input({
      remote: { version: 2, shapes: [rect('shape:u', 0, { parentId: 'shape:f' })] },
      snapshot: snap({
        shapes: new Map([['shape:u', present()], ['shape:f', present()]]),
        canonical: new Map([['shape:u', canon(cur)]]),
      }),
    }),
  );
  const update = opOf(plan.ops, 'shapeUpdate');
  expect((update!.partials[0] as { parentId?: string }).parentId).toBe('shape:f');
});

test('6c. no dangling reparent: the remote frame is absent locally, parentId stays stripped', () => {
  const cur = rect('shape:u', 0);
  const plan = planReconcile(
    input({
      remote: { version: 2, shapes: [rect('shape:u', 0, { parentId: 'shape:missing' })] },
      snapshot: snap({
        shapes: new Map([['shape:u', present()]]),
        canonical: new Map([['shape:u', canon(cur)]]),
      }),
    }),
  );
  const update = opOf(plan.ops, 'shapeUpdate');
  expect('parentId' in (update!.partials[0] as object)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Delete only if mirrored
// ─────────────────────────────────────────────────────────────────────────────

test('7. delete only if mirrored: an absent local shape deletes only when mirrored', () => {
  const base = () =>
    input({
      remote: { version: 2, shapes: [] },
      snapshot: snap({
        shapes: new Map([['shape:x', present()]]),
        canonical: new Map([['shape:x', canon(rect('shape:x', 0))]]),
      }),
    });

  const notMirrored = planReconcile({ ...base(), mirroredShapes: new Set() });
  expect(opOf(notMirrored.ops, 'shapeDelete')).toBeUndefined();

  const mirrored = planReconcile({ ...base(), mirroredShapes: new Set(['shape:x']) });
  expect(idsOf(opOf(mirrored.ops, 'shapeDelete'))).toEqual(['shape:x']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Arrow binding after both terminals exist
// ─────────────────────────────────────────────────────────────────────────────

test('8. binding when both terminals are created this batch: bindingCreate ordered after shapeCreate', () => {
  const plan = planReconcile(
    input({
      remote: {
        version: 1,
        shapes: [arrow('shape:arr', { endShapeId: 'shape:tgt' }), rect('shape:tgt', 0)],
      },
    }),
  );
  const create = opOf(plan.ops, 'bindingCreate');
  expect(create?.bindings).toHaveLength(1);
  expect((create!.bindings[0] as { fromId: string; toId: string }).fromId).toBe('shape:arr');
  expect((create!.bindings[0] as { fromId: string; toId: string }).toId).toBe('shape:tgt');
  // The bindingCreate op must come after the shapeCreate op that makes the target.
  const kinds = plan.ops.map((o) => o.kind);
  expect(kinds.indexOf('shapeCreate')).toBeLessThan(kinds.indexOf('bindingCreate'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Binding to an absent target -> free terminal
// ─────────────────────────────────────────────────────────────────────────────

test('9. absent target: no bindingCreate; a stale existing binding is deleted', () => {
  const remoteArrow = arrow('shape:arr', { endShapeId: 'shape:ghost' });
  const plan = planReconcile(
    input({
      remote: { version: 2, shapes: [remoteArrow] },
      snapshot: snap({
        shapes: new Map([['shape:arr', present()]]),
        // Same canon -> no shapeUpdate, isolating the binding behavior.
        canonical: new Map([['shape:arr', canon(remoteArrow)]]),
        arrowBindings: new Map([['shape:arr', { end: { id: 'binding:1', toId: 'shape:old' } }]]),
      }),
    }),
  );
  // ghost exists nowhere -> terminal stays free -> no create.
  expect(opOf(plan.ops, 'bindingCreate')).toBeUndefined();
  // the old binding is now stale -> delete it.
  expect(idsOf(opOf(plan.ops, 'bindingDelete'))).toEqual(['binding:1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Asset upsert
// ─────────────────────────────────────────────────────────────────────────────

describe('11. image asset upsert', () => {
  test('changed src on an existing asset -> assetUpdate (no assetCreate)', () => {
    const plan = planReconcile(
      input({
        remote: { version: 1, shapes: [image('shape:img', 'data:image/png;base64,NEW')] },
        snapshot: snap({
          assets: new Map([[imageAssetId('shape:img'), tlasset(imageAssetId('shape:img'), 'data:image/png;base64,OLD')]]),
        }),
      }),
    );
    expect(opOf(plan.ops, 'assetCreate')).toBeUndefined();
    const update = opOf(plan.ops, 'assetUpdate');
    expect(update?.assets).toHaveLength(1);
    expect((update!.assets[0]!.props as { src: string }).src).toBe('data:image/png;base64,NEW');
  });

  test('a new image -> assetCreate ordered before its shapeCreate', () => {
    const plan = planReconcile(
      input({
        remote: { version: 1, shapes: [image('shape:img', 'data:image/png;base64,XXX')] },
      }),
    );
    expect(opOf(plan.ops, 'assetCreate')?.assets).toHaveLength(1);
    const kinds = plan.ops.map((o) => o.kind);
    expect(kinds.indexOf('assetCreate')).toBeLessThan(kinds.indexOf('shapeCreate'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Op-ordering invariant across a mixed batch
// ─────────────────────────────────────────────────────────────────────────────

test('12. op-ordering invariant: a batch touching every kind emits them in canonical order', () => {
  const uCur = rect('shape:u', 0);
  const aexist = arrow('shape:aexist'); // remote: no binding (free)
  const plan = planReconcile(
    input({
      remote: {
        version: 2,
        shapes: [
          rect('shape:u', 99), // existing, changed -> shapeUpdate
          rect('shape:c', 0), // new -> shapeCreate
          image('shape:inew', 'data:image/png;base64,NEW'), // new image, no asset -> assetCreate
          image('shape:iupd', 'data:image/png;base64,NEW'), // new image, asset exists w/ old src -> assetUpdate
          arrow('shape:anew', { endShapeId: 'shape:c' }), // new arrow bound to created target -> bindingCreate
          aexist, // existing arrow, binding now stale -> bindingDelete
          // shape:d is absent -> shapeDelete (mirrored)
        ],
      },
      mirroredShapes: new Set(['shape:d']),
      snapshot: snap({
        shapes: new Map([
          ['shape:u', present()],
          ['shape:d', present()],
          ['shape:aexist', present()],
        ]),
        canonical: new Map([
          ['shape:u', canon(uCur)],
          ['shape:aexist', canon(aexist)], // unchanged -> no shapeUpdate for the arrow
        ]),
        assets: new Map([[imageAssetId('shape:iupd'), tlasset(imageAssetId('shape:iupd'), 'data:image/png;base64,OLD')]]),
        arrowBindings: new Map([['shape:aexist', { end: { id: 'binding:stale', toId: 'shape:old' } }]]),
      }),
    }),
  );

  const kinds = plan.ops.map((o) => o.kind);
  // Every kind fired exactly once — and there is no page op kind left to fire.
  expect(([...kinds] as string[]).sort()).toEqual(
    ['assetCreate', 'assetUpdate', 'bindingCreate', 'bindingDelete', 'shapeCreate', 'shapeDelete', 'shapeUpdate'].sort(),
  );
  // ...and in the canonical apply order.
  expect(kinds).toEqual([
    'assetCreate',
    'assetUpdate',
    'shapeCreate',
    'shapeUpdate',
    'shapeDelete',
    'bindingDelete',
    'bindingCreate',
  ]);
});
