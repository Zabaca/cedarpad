// Per-canvas component path resolution (ADR-0007 Option B: one vite, per-canvas dirs).
// The default canvas must resolve to today's flat `src/canvas-components/` path — any
// drift there silently breaks every existing canvas — while other canvases get their
// own `src/canvas-<id>/components/` dir.

import { describe, expect, test } from 'bun:test';

import { componentUrl, componentUrls, sharedComponentUrl, DEFAULT_CANVAS_ID } from './component-loader';

describe('componentUrl: per-canvas import path resolution', () => {
  test('default canvas → today\'s flat path (behavior-preserving)', () => {
    expect(componentUrl('KpiCard', 3, 1, DEFAULT_CANVAS_ID)).toBe('/src/canvas-components/KpiCard.tsx?r=3&n=1');
  });

  test('omitted canvasId defaults to the default canvas path', () => {
    expect(componentUrl('KpiCard', 3, 1)).toBe('/src/canvas-components/KpiCard.tsx?r=3&n=1');
    expect(componentUrl('KpiCard', 3, 1)).toBe(componentUrl('KpiCard', 3, 1, DEFAULT_CANVAS_ID));
  });

  test('a non-default canvas resolves to its own per-canvas dir', () => {
    expect(componentUrl('KpiCard', 7, 2, 'abc123')).toBe('/src/canvas-abc123/components/KpiCard.tsx?r=7&n=2');
  });

  test('distinct canvasIds resolve to distinct dirs for the same module', () => {
    const a = componentUrl('Chart', 1, 1, 'A');
    const b = componentUrl('Chart', 1, 1, 'B');
    expect(a).not.toBe(b);
    expect(a).toContain('/src/canvas-A/components/');
    expect(b).toContain('/src/canvas-B/components/');
  });

  test('rev and nonce still cache-bust (carried through unchanged)', () => {
    expect(componentUrl('X', 5, 9, 'c')).toBe('/src/canvas-c/components/X.tsx?r=5&n=9');
  });
});

// #55: a placed instance references a shared module by its BARE name; the loader resolves
// own-dir first, then the workspace shared library (`@shared` → shared/components/).
describe('shared resolution: own-dir first, then the shared library', () => {
  test('sharedComponentUrl → the workspace shared/components dir (the @shared source)', () => {
    expect(sharedComponentUrl('KpiCard', 3, 1)).toBe('/shared/components/KpiCard.tsx?r=3&n=1');
  });

  test('componentUrls resolves own-dir FIRST, shared library SECOND (default canvas)', () => {
    expect(componentUrls('KpiCard', 3, 1, 2, DEFAULT_CANVAS_ID)).toEqual([
      '/src/canvas-components/KpiCard.tsx?r=3&n=1',
      '/shared/components/KpiCard.tsx?r=3&n=2',
    ]);
  });

  test('a non-default canvas: own per-canvas dir first, the same shared dir second', () => {
    expect(componentUrls('Chart', 7, 1, 2, 'abc')).toEqual([
      '/src/canvas-abc/components/Chart.tsx?r=7&n=1',
      '/shared/components/Chart.tsx?r=7&n=2',
    ]);
  });

  test('the shared candidate is canvas-agnostic (one source across canvases)', () => {
    const a = componentUrls('Chart', 1, 1, 1, 'A')[1];
    const b = componentUrls('Chart', 1, 1, 1, 'B')[1];
    expect(a).toBe(b);
  });
});
