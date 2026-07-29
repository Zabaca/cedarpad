// Per-canvas component path resolution (ADR-0014: uniform canvas dirs). EVERY canvas —
// default included — resolves its own `src/canvas-<id>/components/` dir first, then the
// workspace shared library, then the read-only platform base at `src/canvas-components/`.

import { describe, expect, test } from 'bun:test';

import { baseComponentUrl, componentUrl, componentUrls, sharedComponentUrl, DEFAULT_CANVAS_ID } from './component-loader';

describe('componentUrl: per-canvas import path resolution', () => {
  test('the default canvas gets its own dir like every other canvas (ADR-0014)', () => {
    expect(componentUrl('KpiCard', 3, 1, DEFAULT_CANVAS_ID)).toBe('/src/canvas-default/components/KpiCard.tsx?r=3&n=1');
  });

  test('omitted canvasId defaults to the default canvas path', () => {
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

// #55 + ADR-0014: a placed instance references a module by its BARE name; the loader
// resolves own → shared (`@shared`) → platform base.
describe('resolution order: own dir, then shared, then the platform base', () => {
  test('sharedComponentUrl → the workspace shared/components dir (the @shared source)', () => {
    expect(sharedComponentUrl('KpiCard', 3, 1, 'cv_1')).toBe('/shared/components/KpiCard.tsx?r=3&n=1&c=cv_1');
  });

  test('baseComponentUrl → the image-baked platform library', () => {
    expect(baseComponentUrl('KpiCard', 3, 1)).toBe('/src/canvas-components/KpiCard.tsx?r=3&n=1');
  });

  test('componentUrls resolves own FIRST, shared SECOND, base LAST (default canvas)', () => {
    expect(componentUrls('KpiCard', 3, 1, 2, DEFAULT_CANVAS_ID, 4)).toEqual([
      '/src/canvas-default/components/KpiCard.tsx?r=3&n=1',
      '/shared/components/KpiCard.tsx?r=3&n=2&c=default',
      '/src/canvas-components/KpiCard.tsx?r=3&n=4',
    ]);
  });

  test('a non-default canvas: own per-canvas dir first, same shared + base after', () => {
    expect(componentUrls('Chart', 7, 1, 2, 'abc', 3)).toEqual([
      '/src/canvas-abc/components/Chart.tsx?r=7&n=1',
      '/shared/components/Chart.tsx?r=7&n=2&c=abc',
      '/src/canvas-components/Chart.tsx?r=7&n=3',
    ]);
  });

  test('the shared and base candidates name ONE source across canvases', () => {
    const a = componentUrls('Chart', 1, 1, 1, 'A', 2);
    const b = componentUrls('Chart', 1, 1, 1, 'B', 2);
    // The shared path is identical; only the `?c=` hint differs, because materializing a
    // shared Record has to name a canvas to prove entitlement to the workspace's library.
    expect((a[1] as string).split('?')[0]).toBe((b[1] as string).split('?')[0]);
    expect(a[1]).toContain('c=A');
    expect(b[1]).toContain('c=B');
    expect(a[2]).toBe(b[2] as string);
  });
});
