// DataTable behavior: windowed rendering (the "must be fast" requirement) and the
// column-layout helpers. Rendering needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import DataTable, { visibleSlice } from './canvas-components/DataTable';

describe('visibleSlice', () => {
  test('windows the rows around the scroll position with overscan', () => {
    expect(visibleSlice(0, 280, 28, 10_000, 10)).toEqual({ start: 0, end: 20 });
    expect(visibleSlice(2800, 280, 28, 10_000, 10)).toEqual({ start: 90, end: 120 });
  });

  test('clamps to the row count', () => {
    expect(visibleSlice(999_999, 280, 28, 50, 10)).toEqual({ start: 40, end: 50 });
    expect(visibleSlice(0, 280, 28, 3, 10)).toEqual({ start: 0, end: 3 });
  });
});

describe('DataTable', () => {
  const render = (el: React.ReactElement) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return host;
  };

  test('renders a window, not the world: 10k rows stay under 100 row nodes', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [`row ${i}`, String(i)]);
    const host = render(<DataTable columns={['name', 'n']} rows={rows} />);
    const rendered = host.querySelectorAll('[data-row]').length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(100);
    expect(host.textContent).toContain('row 0');
    expect(host.textContent).toContain('10,000 rows');
  });

  test('reports truncation when totalRows exceeds what was kept', () => {
    const host = render(<DataTable columns={['a']} rows={[['1'], ['2']]} totalRows={500} />);
    expect(host.textContent).toContain('first 2 of 500');
  });

  test('tolerates empty props (fresh placement from the gallery)', () => {
    const host = render(<DataTable />);
    expect(host.textContent).toContain('0 rows');
  });
});
