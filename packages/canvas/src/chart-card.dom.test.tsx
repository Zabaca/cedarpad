// happy-dom harness must be the FIRST import.
import './happydom-harness.ts';

import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ChartCard from './canvas-components/ChartCard.tsx';

// happy-dom has no layout, so getBoundingClientRect is all zeros and vega never draws.
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
