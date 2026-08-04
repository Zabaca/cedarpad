// FlintGallery behavior. The chart itself cannot be asserted here — happy-dom has no
// layout, so ChartCard's Vega view never draws (it bails at width < 1). What is testable
// is the part that would silently mislead: that every catalogue entry only uses channels
// its chart type declares. Flint DROPS an undeclared channel and renders a confident,
// wrong chart, so a bad encoding in this gallery would look like a working example.
// Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { vlGetTemplateChannels } from 'flint-chart/vegalite';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import FlintGallery, { SPECS } from './canvas-components/FlintGallery';
import { isInteractiveControl } from './predicates';

const render = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return host;
};

describe('FlintGallery catalogue', () => {
  test('every chart type in the catalogue exists in the installed flint-chart', () => {
    for (const s of SPECS) {
      expect({ chart: s.chart, known: vlGetTemplateChannels(s.chart).length > 0 }).toEqual({
        chart: s.chart,
        known: true,
      });
    }
  });

  test('every spec encodes only channels its chart type declares', () => {
    for (const s of SPECS) {
      const allowed = vlGetTemplateChannels(s.chart);
      const undeclared = Object.keys(s.encodings).filter((c) => !allowed.includes(c));
      expect({ chart: s.chart, undeclared }).toEqual({ chart: s.chart, undeclared: [] });
    }
  });

  test('every spec names a dataset that carries all its fields', () => {
    for (const s of SPECS) {
      const row = SAMPLE[s.data] ?? {};
      expect({ chart: s.chart, dataset: s.data, known: Boolean(SAMPLE[s.data]) }).toEqual({
        chart: s.chart,
        dataset: s.data,
        known: true,
      });
      const missing = Object.values(s.encodings)
        .map((e) => e.field)
        .filter((field) => !(field in row));
      expect({ chart: s.chart, missing }).toEqual({ chart: s.chart, missing: [] });
    }
  });
});

describe('FlintGallery card', () => {
  test('lists every chart type as a real button, grouped by category', () => {
    const host = render(<FlintGallery />);
    const names = [...host.querySelectorAll('nav button')].map((b) => b.textContent);
    expect(names.length).toBe(SPECS.length);
    expect(names).toContain('Grouped Bar Chart');
    for (const b of host.querySelectorAll('button')) expect(isInteractiveControl(b)).toBe(true);
  });

  test('picking a chart persists through setData', () => {
    let patch: { chart?: string } | null = null;
    const host = render(<FlintGallery setData={(p) => (patch = p)} />);
    const pie = [...host.querySelectorAll('nav button')].find((b) => b.textContent === 'Pie Chart');
    act(() => (pie as HTMLElement).click());
    expect((patch as { chart?: string } | null)?.chart).toBe('Pie Chart');
  });

  test('without a host it still selects locally', () => {
    const host = render(<FlintGallery />);
    const pie = [...host.querySelectorAll('nav button')].find((b) => b.textContent === 'Pie Chart');
    act(() => (pie as HTMLElement).click());
    expect(host.textContent).toContain('"Pie Chart"'); // the spec panel now shows it
  });

  test('the spec panel shows the place_component call and any trap note', () => {
    const host = render(<FlintGallery chart="Grouped Bar Chart" />);
    expect(host.textContent).toContain('place_component(module="ChartCard"');
    expect(host.textContent).toContain('Takes `group`, NOT `color`');
  });

  test('an unknown chart name falls back rather than crashing on a fresh placement', () => {
    const host = render(<FlintGallery chart="Sankey" />);
    expect(host.textContent).toContain(SPECS[0].chart);
  });
});

// Mirrors the shape of each dataset in FlintGallery. Kept here rather than exported from
// the component so the test asserts against an independently written expectation.
const SAMPLE: Record<string, Record<string, unknown>> = {
  sales: { quarter: 1, region: 1, revenue: 1, units: 1, margin: 1 },
  trend: { month: 1, region: 1, users: 1 },
  dist: { value: 1, cohort: 1 },
  points: { spend: 1, conversions: 1, impressions: 1, channel: 1 },
  ohlc: { day: 1, open: 1, high: 1, low: 1, close: 1 },
  ranks: { year: 1, team: 1, rank: 1 },
  band: { month: 1, lo: 1, hi: 1 },
  tasks: { task: 1, team: 1, start: 1, end: 1 },
  cities: { city: 1, lon: 1, lat: 1, pop: 1 },
  kpi: { metric: 1, value: 1, goal: 1 },
  paired: { segment: 1, phase: 1, value: 1 },
  targets: { segment: 1, value: 1, target: 1 },
  waterfall: { step: 1, delta: 1 },
  pyramid: { age: 1, gender: 1, count: 1 },
};
