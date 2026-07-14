import { describe, expect, test } from 'bun:test';

import { normalizeIncomingShape, normalizeShape, parseParentId } from './normalize';

// parentId parsing was previously inlined identically in three places
// (normalizeShape, and the image/embed branches of normalizeIncomingShape).
// These pin the shared rule: keep a `shape:`-prefixed id, drop anything else.
describe('parseParentId', () => {
  test('keeps a shape:-prefixed parentId', () => {
    expect(parseParentId({ parentId: 'shape:f1' })).toBe('shape:f1');
  });

  test('drops a non-shape parent (page:) and a non-string', () => {
    expect(parseParentId({ parentId: 'page:page' })).toBeUndefined();
    expect(parseParentId({ parentId: 42 })).toBeUndefined();
  });

  test('absent parentId is undefined', () => {
    expect(parseParentId({})).toBeUndefined();
  });
});

describe('normalize preserves the parentId rule at every call site', () => {
  test('normalizeShape keeps a frame parent, drops a page parent', () => {
    expect(normalizeShape({ id: 'shape:a', type: 'rectangle', x: 0, y: 0, parentId: 'shape:f' }).parentId).toBe('shape:f');
    expect(normalizeShape({ id: 'shape:b', type: 'rectangle', x: 0, y: 0, parentId: 'page:page' }).parentId).toBeUndefined();
  });

  test('incoming image keeps a frame parent, drops a page parent', () => {
    expect(normalizeIncomingShape({ id: 'shape:i', type: 'image', x: 0, y: 0, parentId: 'shape:f' }).parentId).toBe('shape:f');
    expect(normalizeIncomingShape({ id: 'shape:i', type: 'image', x: 0, y: 0, parentId: 'page:page' }).parentId).toBeUndefined();
  });

  test('incoming embed keeps a frame parent, drops a page parent', () => {
    expect(normalizeIncomingShape({ id: 'shape:e', type: 'embed', x: 0, y: 0, parentId: 'shape:f' }).parentId).toBe('shape:f');
    expect(normalizeIncomingShape({ id: 'shape:e', type: 'embed', x: 0, y: 0, parentId: 'page:page' }).parentId).toBeUndefined();
  });
});
