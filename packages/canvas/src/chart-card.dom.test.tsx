// happy-dom harness must be the FIRST import.
import './happydom-harness.ts';

import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ChartCard from './canvas-components/ChartCard.tsx';
import { applyFit } from './chart-fit.ts';

// happy-dom has no layout, so every measurement is zero and vega never draws.
// What IS testable here — and what actually bites — is the guard: Flint SILENTLY DROPS a
// channel the template doesn't declare, so `color` on a Grouped Bar Chart (which wants
// `group`) renders a plain bar chart with the series overplotted and no error at all.
// These pin the warning that turns that silent-wrong into a visible one.

function render(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    createRoot(host).render(<ChartCard {...props} />);
  });
  return host;
}

const ROWS = [
  { region: 'North', qtr: 'Q1', revenue: 120 },
  { region: 'South', qtr: 'Q1', revenue: 90 },
];

test('an undeclared channel is named, not silently dropped', () => {
  const host = render({
    values: ROWS,
    semantic_types: { region: 'Category', qtr: 'Quarter', revenue: 'Price' },
    chartType: 'Grouped Bar Chart',
    encodings: { x: { field: 'qtr' }, y: { field: 'revenue' }, color: { field: 'region' } },
  });
  expect(host.textContent).toContain('"color"');
  expect(host.textContent).toContain('group'); // the channel it should have used
});

test('the documented channel set is accepted', () => {
  const host = render({
    values: ROWS,
    semantic_types: { region: 'Category', qtr: 'Quarter', revenue: 'Price' },
    chartType: 'Grouped Bar Chart',
    encodings: { x: { field: 'qtr' }, y: { field: 'revenue' }, group: { field: 'region' } },
  });
  expect(host.textContent).not.toContain('channel');
});

test('an unknown chart type is reported', () => {
  const host = render({ values: ROWS, chartType: 'Pie Chart Deluxe', encodings: { x: { field: 'qtr' } } });
  expect(host.textContent).toContain('Unknown chart type');
});

// #239: the host injects `rows` ONLY for a mart-backed placement, and injects `rows: []`
// while that mart is loading/empty/misnamed. Presence — not length — has to select the
// source, or a slow mart would flash the inline snapshot as if it were live data.
test('a mart-backed placement charts rows, not inline values', () => {
  const host = render({
    values: ROWS,
    rows: [],
    semantic_types: { region: 'Category', qtr: 'Quarter', revenue: 'Price' },
    chartType: 'Grouped Bar Chart',
    encodings: { x: { field: 'qtr' }, y: { field: 'revenue' }, group: { field: 'region' } },
  });
  // An empty mart renders an empty chart, never an error and never the stale snapshot.
  expect(host.textContent).not.toContain('channel');
  expect(host.textContent).not.toContain('Unknown');
});

// The card is measured with `clientWidth`, not `getBoundingClientRect()`, because it renders
// inside tldraw's CSS-scaled container — the rect is post-transform, so below 100% zoom the
// chart was laid out small and then scaled back up, under-filling the card. `applyFit` is
// the other half: it makes that measurement the OUTER size, so the axis gutter, title and
// legend come out of it rather than being added to it.
test('applyFit makes the given size the outer size of a single view', () => {
  const spec: Record<string, unknown> = { mark: 'line' };
  applyFit(spec, 900, 400);
  expect(spec).toMatchObject({ width: 900, height: 400, autosize: { type: 'fit', contains: 'padding' } });
});

test('applyFit leaves a layered spec fittable', () => {
  const spec: Record<string, unknown> = { layer: [{ mark: 'line' }, { mark: 'point' }] };
  applyFit(spec, 900, 400);
  expect(spec.autosize).toBeDefined();
});

// Vega-Lite refuses `fit` on a composition and renders UNSIZED if you ask — worse than not
// asking. Flint emits these for `column`/`row` facets.
test('applyFit declines on facet/concat/repeat rather than costing them their size', () => {
  for (const key of ['facet', 'spec', 'concat', 'hconcat', 'vconcat', 'repeat']) {
    const spec: Record<string, unknown> = { [key]: {} };
    applyFit(spec, 900, 400);
    expect({ key, width: spec.width, autosize: spec.autosize }).toEqual({ key, width: undefined, autosize: undefined });
  }
});
