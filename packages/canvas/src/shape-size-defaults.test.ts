// The drift guard for SHAPE_SIZE_DEFAULTS (issue #187). For every box shape type,
// BOTH the create/validate path (normalize) and the tldraw decode fallback
// (fromTldrawShape) must produce the SAME default w×h when size is omitted — and
// that value must be the one in the table. Before the table these lived inline in
// each place and had drifted (rectangle was 160×100 on create but 100×100 on
// decode); this test fails against that split.
//
// Keying FIXTURES by `keyof typeof SHAPE_SIZE_DEFAULTS` makes the catalog itself a
// checklist: add a box type to the table without a fixture here and this file
// stops compiling.

import { describe, expect, test } from 'bun:test';

import type { TLShape } from 'tldraw';

import { SHAPE_SIZE_DEFAULTS } from './shapes';
import { normalizeIncomingShape } from './normalize';
import { fromTldrawShape } from './tldraw-conventions';

type BoxType = keyof typeof SHAPE_SIZE_DEFAULTS;

// Per type: a minimal create input (no w/h) and a minimal tldraw shape (no w/h in
// props), so each path hits its default rather than an explicit size. `create`
// carries the few fields each validator requires (module for component; an id for
// the human-only image/embed). `tldrawType` is tldraw's own type name — 'geo' for
// rectangle/ellipse.
const FIXTURES: Record<BoxType, { create: Record<string, unknown>; tldraw: Record<string, unknown> }> = {
  rectangle: {
    create: { type: 'rectangle', x: 0, y: 0 },
    tldraw: { id: 'shape:x', type: 'geo', x: 0, y: 0, props: { geo: 'rectangle', color: 'black' } },
  },
  ellipse: {
    create: { type: 'ellipse', x: 0, y: 0 },
    tldraw: { id: 'shape:x', type: 'geo', x: 0, y: 0, props: { geo: 'ellipse', color: 'black' } },
  },
  component: {
    create: { type: 'component', x: 0, y: 0, module: 'KpiCard' },
    tldraw: { id: 'shape:x', type: 'component', x: 0, y: 0, props: { module: 'KpiCard', data: {}, rev: 0, color: 'black' } },
  },
  chat: {
    create: { type: 'chat', x: 0, y: 0 },
    tldraw: { id: 'shape:x', type: 'chat', x: 0, y: 0, props: { title: 'Chat', color: 'black' } },
  },
  image: {
    create: { type: 'image', id: 'shape:x', x: 0, y: 0 },
    tldraw: { id: 'shape:x', type: 'image', x: 0, y: 0, props: { altText: '', color: 'black' } },
  },
  frame: {
    create: { type: 'frame', x: 0, y: 0 },
    tldraw: { id: 'shape:x', type: 'frame', x: 0, y: 0, props: { name: '', color: 'black' } },
  },
  embed: {
    create: { type: 'embed', id: 'shape:x', x: 0, y: 0 },
    tldraw: { id: 'shape:x', type: 'embed', x: 0, y: 0, props: { url: '', color: 'black' } },
  },
};

describe('SHAPE_SIZE_DEFAULTS is the single source for box defaults (no normalize↔decode drift)', () => {
  for (const type of Object.keys(FIXTURES) as BoxType[]) {
    const { create, tldraw } = FIXTURES[type];
    const expected = SHAPE_SIZE_DEFAULTS[type];

    test(`${type}: the create/validate default matches the table`, () => {
      const s = normalizeIncomingShape(create) as { w: number; h: number };
      expect({ w: s.w, h: s.h }).toEqual(expected);
    });

    test(`${type}: the tldraw decode fallback matches the table`, () => {
      const s = fromTldrawShape(tldraw as unknown as TLShape, { plaintext: '' }) as { w: number; h: number } | null;
      expect(s).not.toBeNull();
      expect({ w: (s as { w: number }).w, h: (s as { h: number }).h }).toEqual(expected);
    });
  }
});
