import { describe, expect, test } from 'bun:test';

import type { CanvasState } from '../src/shapes.ts';
import { martsReferencedBy } from './mart-scope.ts';

// ADR-0017 guest scoping, one level below decideGuestGate: the marts a canvas may expose
// are exactly the ones its OWN component instances reference — never the workspace's mart
// list. This is the pure resolver worker/mart-api.ts's guest branch consults.

const state = (shapes: CanvasState['shapes']): CanvasState => ({ version: 1, shapes });

describe('martsReferencedBy', () => {
  test('collects mart names from component shapes with a mart dataSource', () => {
    const s = state([
      { id: 'shape:1', color: 'black', type: 'component', x: 0, y: 0, w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'mart', name: 'mart_a' } },
      { id: 'shape:2', color: 'black', type: 'component', x: 0, y: 0, w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'mart', name: 'mart_b' } },
    ]);
    expect(martsReferencedBy(s)).toEqual(new Set(['mart_a', 'mart_b']));
  });

  test('ignores non-component shapes and components with no dataSource', () => {
    const s = state([
      { id: 'shape:1', color: 'black', type: 'rectangle', x: 0, y: 0, w: 1, h: 1, text: '' },
      { id: 'shape:2', color: 'black', type: 'component', x: 0, y: 0, w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1 },
    ]);
    expect(martsReferencedBy(s)).toEqual(new Set());
  });

  test('an empty canvas references no marts', () => {
    expect(martsReferencedBy(state([]))).toEqual(new Set());
  });

  test('duplicate references to the same mart collapse to one entry', () => {
    const s = state([
      { id: 'shape:1', color: 'black', type: 'component', x: 0, y: 0, w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'mart', name: 'mart_a' } },
      { id: 'shape:2', color: 'black', type: 'component', x: 0, y: 0, w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'mart', name: 'mart_a' } },
    ]);
    expect(martsReferencedBy(s)).toEqual(new Set(['mart_a']));
  });
});
