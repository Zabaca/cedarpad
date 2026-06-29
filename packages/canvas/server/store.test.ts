import { describe, expect, test } from 'bun:test';

import { createStore } from '../src/store.ts';
import type { CanvasShape } from '../src/shapes.ts';

const rect = (id: string, x = 0): CanvasShape => ({ id, type: 'rectangle', x, y: 0, w: 10, h: 10, color: 'black', text: '' });

describe('store', () => {
  test('starts empty at version 0', () => {
    const s = createStore();
    expect(s.getState()).toEqual({ version: 0, shapes: [], pages: [] });
  });

  test('upsert bumps version and is keyed by id', () => {
    const s = createStore();
    expect(s.upsert([rect('shape:a')])).toBe(1);
    expect(s.upsert([rect('shape:a', 99)])).toBe(2); // same id -> replace, not append
    const st = s.getState();
    expect(st.shapes).toHaveLength(1);
    expect(st.shapes[0]).toMatchObject({ id: 'shape:a', x: 99 });
  });

  test('empty upsert does not bump version', () => {
    const s = createStore();
    s.upsert([rect('shape:a')]);
    const before = s.getState().version;
    expect(s.upsert([])).toBe(before);
  });

  test('remove only bumps when something was removed', () => {
    const s = createStore([rect('shape:a')]);
    expect(s.remove(['nope'])).toBe(0);
    expect(s.remove(['shape:a'])).toBe(1);
    expect(s.getState().shapes).toHaveLength(0);
  });

  test('clear is a no-op on an empty store', () => {
    const s = createStore();
    expect(s.clear()).toBe(0);
    s.upsert([rect('shape:a')]);
    expect(s.clear()).toBe(2);
  });

  test('upsert of an identical shape is a no-op (no version bump, no onChange)', () => {
    const versions: number[] = [];
    const s = createStore([rect('shape:a')], (st) => versions.push(st.version));
    const before = s.getState().version;
    expect(s.upsert([rect('shape:a')])).toBe(before); // byte-identical pre-image
    expect(versions).toEqual([]);
  });

  test('empty upsert does not bump and does not fire onChange', () => {
    const versions: number[] = [];
    const s = createStore([rect('shape:a')], (st) => versions.push(st.version));
    const before = s.getState().version;
    expect(s.upsert([])).toBe(before);
    expect(versions).toEqual([]);
  });

  test('upsert of mixed identical+changed+new bumps exactly once and fires once', () => {
    const versions: number[] = [];
    const s = createStore([rect('shape:a'), rect('shape:b')], (st) => versions.push(st.version));
    const before = s.getState().version;
    // identical A (no-op), changed B (x moves), brand-new C
    expect(s.upsert([rect('shape:a'), rect('shape:b', 50), rect('shape:c')])).toBe(before + 1);
    expect(versions).toEqual([before + 1]);
    expect(s.getState().shapes.map((x) => x.id)).toEqual(['shape:a', 'shape:b', 'shape:c']);
  });

  test('upsert of a brand-new shape bumps exactly once and fires once', () => {
    const versions: number[] = [];
    const s = createStore([], (st) => versions.push(st.version));
    expect(s.upsert([rect('shape:a')])).toBe(1);
    expect(versions).toEqual([1]);
  });

  test('upsertPages: identical page is a no-op, mixed identical+changed bumps once', () => {
    const versions: number[] = [];
    const s = createStore([], (st) => versions.push(st.version));
    expect(
      s.upsertPages([
        { id: 'page:a', name: 'A', index: 'a1' },
        { id: 'page:b', name: 'B', index: 'a2' },
      ]),
    ).toBe(1); // both new
    expect(s.upsertPages([{ id: 'page:a', name: 'A', index: 'a1' }])).toBe(1); // identical -> no-op
    // A unchanged (no-op), B renamed (change) -> exactly one bump
    expect(
      s.upsertPages([
        { id: 'page:a', name: 'A', index: 'a1' },
        { id: 'page:b', name: 'B renamed', index: 'a2' },
      ]),
    ).toBe(2);
    expect(versions).toEqual([1, 2]);
  });

  test('shapes come back sorted by id (deterministic reads)', () => {
    const s = createStore();
    s.upsert([rect('shape:c'), rect('shape:a'), rect('shape:b')]);
    expect(s.getState().shapes.map((x) => x.id)).toEqual(['shape:a', 'shape:b', 'shape:c']);
  });

  test('onChange fires once per real mutation, never on no-ops', () => {
    const versions: number[] = [];
    const s = createStore([], (st) => versions.push(st.version));
    s.upsert([rect('shape:a')]); // 1
    s.upsert([]); // no-op
    s.remove(['nope']); // no-op
    s.remove(['shape:a']); // 2
    s.clear(); // no-op (already empty)
    expect(versions).toEqual([1, 2]);
  });

  test('pages: upsert/remove bump version, dedupe by id, sort by index', () => {
    const s = createStore();
    expect(s.upsertPages([{ id: 'page:b', name: 'B', index: 'a2' }, { id: 'page:a', name: 'A', index: 'a1' }])).toBe(1);
    expect(s.getState().pages.map((p) => p.id)).toEqual(['page:a', 'page:b']); // ordered by index
    expect(s.upsertPages([{ id: 'page:a', name: 'A', index: 'a1' }])).toBe(1); // identical -> no bump
    expect(s.upsertPages([{ id: 'page:a', name: 'A renamed', index: 'a1' }])).toBe(2); // change -> bump
    expect(s.removePages(['nope'])).toBe(2); // missing -> no bump
    expect(s.removePages(['page:b'])).toBe(3);
    expect(s.getState().pages.map((p) => p.id)).toEqual(['page:a']);
  });

  test('clear drops shapes but leaves pages intact', () => {
    const s = createStore([rect('shape:a')], undefined, [{ id: 'page:a', name: 'A', index: 'a1' }]);
    s.clear();
    expect(s.getState().shapes).toHaveLength(0);
    expect(s.getState().pages).toHaveLength(1);
  });
});
