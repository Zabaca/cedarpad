import { describe, expect, test } from 'bun:test';

import { applyCanvasOrder, moved, parseCanvasOrder } from './canvas-order';

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const list = (...xs: string[]) => xs.map((id) => ({ id, name: id }));

describe('applyCanvasOrder', () => {
  test('puts the canvases in the stored order', () => {
    expect(ids(applyCanvasOrder(['c', 'a', 'b'], list('a', 'b', 'c')))).toEqual(['c', 'a', 'b']);
  });

  test('no stored order leaves the list exactly as the server sent it', () => {
    // Which is `created_at` ascending — so a workspace that has never reordered sees no
    // change at all, rather than an arbitrary rearrangement.
    expect(ids(applyCanvasOrder([], list('a', 'b', 'c')))).toEqual(['a', 'b', 'c']);
  });

  test('a canvas the order has never seen goes to the END, keeping its relative position', () => {
    // Created since the last reorder — by you on another device, or by a teammate. It must
    // appear, and it must not silently jump to the front of an order you arranged.
    expect(ids(applyCanvasOrder(['c', 'a'], list('a', 'b', 'c', 'd')))).toEqual(['c', 'a', 'b', 'd']);
  });

  test('an id in the order that no longer exists is dropped, not rendered as a gap', () => {
    expect(ids(applyCanvasOrder(['gone', 'b', 'a'], list('a', 'b')))).toEqual(['b', 'a']);
  });

  test('a duplicated id is honored once', () => {
    // The order is written by clients; a bad write must not duplicate a row on screen.
    expect(ids(applyCanvasOrder(['a', 'a', 'b'], list('a', 'b')))).toEqual(['a', 'b']);
  });
});

describe('parseCanvasOrder', () => {
  test('reads a stored array', () => {
    expect(parseCanvasOrder('["a","b"]')).toEqual(['a', 'b']);
  });

  test('anything unreadable is no order at all, never a throw', () => {
    // This column is JSON text in D1. A read path that throws would take the whole canvas
    // picker down over a preference.
    expect(parseCanvasOrder(null)).toEqual([]);
    expect(parseCanvasOrder('not json')).toEqual([]);
    expect(parseCanvasOrder('{"a":1}')).toEqual([]);
    expect(parseCanvasOrder('[1,2]')).toEqual([]);
  });
});

describe('moved', () => {
  test('moves an item to a new index', () => {
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  test('dropping an item on itself changes nothing', () => {
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });
});
