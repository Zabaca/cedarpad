// Flint chart gallery. Every chart type `flint-chart` ships, live-rendered off demo data,
// with the exact `place_component(module="ChartCard", …)` spec that produced it.
//
// It renders through ChartCard rather than calling Flint directly — the point is to show
// what an agent can actually put on this canvas, so the gallery has to be the same code
// path. Picking a chart swaps ChartCard's props and nothing else.
//
// The datasets are shared across chart types on purpose: the same 16 sales rows become a
// bar, a heatmap, a pie and a radar. That is the argument for Flint — you write intent
// (a chart type + which field goes on which channel) and it derives scales, axes, legend,
// colors and layout. The spec panel is the whole payload; there is no chart-drawing code.
//
// The channel lists come from `skills/chart-authoring/SKILL.md`, which is GENERATED from the
// installed flint-chart. A channel a type doesn't declare is silently dropped by Flint — it
// draws a confident, wrong chart — so every encoding here is checked against that table.
import { useState } from 'react';

import ChartCard from './ChartCard';

export type Spec = {
  chart: string;
  category: string;
  encodings: Record<string, { field: string; aggregate?: string }>;
  /** Which of the demo datasets below feeds it. Keyed, so a typo is a type error. */
  data: keyof typeof DATA;
  note?: string;
};

/* ── demo data ──────────────────────────────────────────────────────────── */

// Deterministic PRNG so the gallery renders the same picture every time — a chart that
// reshuffles on reload is useless for comparing types against each other.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
const REGIONS = ['North', 'South', 'East', 'West'];

const sales = (() => {
  const r = rng(7);
  return QUARTERS.flatMap((quarter, qi) =>
    REGIONS.map((region, ri) => ({
      quarter,
      region,
      revenue: Math.round(40 + qi * 12 + ri * 9 + r() * 25),
      units: Math.round(120 + qi * 30 + r() * 90),
      margin: Math.round((18 + ri * 3 + r() * 10) * 10) / 10,
    })),
  );
})();

const trend = (() => {
  const r = rng(21);
  const regions = ['North', 'South', 'East'];
  return Array.from({ length: 12 }, (_, m) =>
    regions.map((region, ri) => ({
      month: `2025-${String(m + 1).padStart(2, '0')}-01`,
      region,
      users: Math.round(400 + ri * 180 + m * (22 + ri * 9) + r() * 120),
    })),
  ).flat();
})();

const dist = (() => {
  const r = rng(33);
  // Two cohorts with different centres, so every distribution type has something to show.
  return ['control', 'variant'].flatMap((cohort, ci) =>
    Array.from({ length: 90 }, () => ({
      cohort,
      // Sum of three uniforms ≈ bell, without importing a stats package.
      value: Math.round((60 + ci * 18 + (r() + r() + r() - 1.5) * 26) * 10) / 10,
    })),
  );
})();

const points = (() => {
  const r = rng(51);
  return ['Search', 'Social', 'Email', 'Direct'].flatMap((channel, ci) =>
    Array.from({ length: 18 }, () => {
      const spend = Math.round(200 + r() * 1800);
      return {
        channel,
        spend,
        // Real correlation plus noise, so Regression has a slope worth drawing.
        conversions: Math.round(spend * (0.018 + ci * 0.004) + r() * 14),
        impressions: Math.round(spend * (30 + r() * 20)),
      };
    }),
  );
})();

const ohlc = (() => {
  const r = rng(64);
  let close = 120;
  return Array.from({ length: 22 }, (_, i) => {
    const open = close;
    close = Math.round((open + (r() - 0.47) * 9) * 100) / 100;
    return {
      day: `2025-06-${String(i + 2).padStart(2, '0')}`,
      open,
      close,
      high: Math.round((Math.max(open, close) + r() * 4) * 100) / 100,
      low: Math.round((Math.min(open, close) - r() * 4) * 100) / 100,
    };
  });
})();

const ranks = (() => {
  const r = rng(88);
  // Each team carries a score that drifts a little each year, and the rank is the sort of
  // it. Drift rather than shuffle: the bump lines have to cross, but a team that teleports
  // from 1st to 5th makes the chart type look broken rather than expressive.
  const teams = ['Atlas', 'Bolt', 'Comet', 'Delta', 'Ember'].map((team, i) => ({ team, score: i }));
  return [2021, 2022, 2023, 2024, 2025, 2026].flatMap((year) => {
    for (const t of teams) t.score += r() * 2.4 - 1.2;
    return [...teams].sort((a, b) => a.score - b.score).map((t, k) => ({ year, team: t.team, rank: k + 1 }));
  });
})();

const band = Array.from({ length: 12 }, (_, m) => {
  const mid = 50 + Math.sin(m / 1.9) * 18;
  return {
    month: `2025-${String(m + 1).padStart(2, '0')}-01`,
    lo: Math.round(mid - 9 - (m % 3) * 2),
    hi: Math.round(mid + 11 + (m % 4) * 2),
  };
});

const tasks = [
  { task: 'Discovery', team: 'Product', start: '2026-01-06', end: '2026-01-24' },
  { task: 'Schema', team: 'Backend', start: '2026-01-20', end: '2026-02-10' },
  { task: 'API', team: 'Backend', start: '2026-02-03', end: '2026-03-06' },
  { task: 'UI', team: 'Frontend', start: '2026-02-17', end: '2026-03-27' },
  { task: 'Beta', team: 'Product', start: '2026-03-16', end: '2026-04-10' },
  { task: 'Launch', team: 'Product', start: '2026-04-06', end: '2026-04-17' },
];

const cities = [
  { city: 'San Francisco', lon: -122.42, lat: 37.77, pop: 874 },
  { city: 'Denver', lon: -104.99, lat: 39.74, pop: 715 },
  { city: 'Austin', lon: -97.74, lat: 30.27, pop: 965 },
  { city: 'Chicago', lon: -87.63, lat: 41.88, pop: 2746 },
  { city: 'Atlanta', lon: -84.39, lat: 33.75, pop: 499 },
  { city: 'New York', lon: -74.01, lat: 40.71, pop: 8336 },
  { city: 'Boston', lon: -71.06, lat: 42.36, pop: 654 },
  { city: 'Seattle', lon: -122.33, lat: 47.61, pop: 755 },
];

const kpi = [{ metric: 'Weekly active', value: 12480, goal: 15000 }];

const paired = ['Onboarding', 'Activation', 'Retention', 'Referral', 'Revenue'].flatMap((segment, i) => [
  { segment, phase: 'before', value: 32 + i * 6 },
  { segment, phase: 'after', value: 41 + i * 9 + (i % 2) * 7 },
]);

const targets = ['Onboarding', 'Activation', 'Retention', 'Referral', 'Revenue'].map((segment, i) => ({
  segment,
  value: 41 + i * 9 + (i % 2) * 7,
  target: 60 + i * 5,
}));

const waterfall = [
  { step: 'Opening', delta: 120 },
  { step: 'New', delta: 46 },
  { step: 'Expansion', delta: 22 },
  { step: 'Downgrade', delta: -13 },
  { step: 'Churn', delta: -28 },
  { step: 'Closing', delta: 147 },
];

const pyramid = ['0–17', '18–29', '30–44', '45–59', '60+'].flatMap((age, i) => [
  { age, gender: 'F', count: 220 - i * 28 },
  { age, gender: 'M', count: 210 - i * 24 },
]);

// Deliberately un-annotated: the inferred literal keys are what make `Spec['data']` a
// closed set, so a spec naming a dataset that does not exist fails typecheck.
const DATA = {
  sales: {
    values: sales,
    types: { quarter: 'Quarter', region: 'Category', revenue: 'Price', units: 'Count', margin: 'Percentage' },
  },
  trend: { values: trend, types: { month: 'Date', region: 'Category', users: 'Count' } },
  dist: { values: dist, types: { value: 'Quantity', cohort: 'Category' } },
  points: {
    values: points,
    types: { spend: 'Price', conversions: 'Count', impressions: 'Count', channel: 'Category' },
  },
  ohlc: { values: ohlc, types: { day: 'Date', open: 'Price', high: 'Price', low: 'Price', close: 'Price' } },
  ranks: { values: ranks, types: { year: 'Year', team: 'Category', rank: 'Rank' } },
  band: { values: band, types: { month: 'Date', lo: 'Price', hi: 'Price' } },
  tasks: { values: tasks, types: { task: 'Category', team: 'Category', start: 'Date', end: 'Date' } },
  cities: { values: cities, types: { city: 'Category', lon: 'Longitude', lat: 'Latitude', pop: 'Count' } },
  kpi: { values: kpi, types: { metric: 'Category', value: 'Count', goal: 'Count' } },
  paired: { values: paired, types: { segment: 'Category', phase: 'Category', value: 'Percentage' } },
  targets: { values: targets, types: { segment: 'Category', value: 'Percentage', target: 'Percentage' } },
  waterfall: { values: waterfall, types: { step: 'Category', delta: 'Price' } },
  pyramid: { values: pyramid, types: { age: 'Category', gender: 'Category', count: 'Count' } },
};

/* ── the catalogue ──────────────────────────────────────────────────────── */

const f = (field: string, aggregate?: string) => (aggregate ? { field, aggregate } : { field });

// Exported so the test can check every entry against the INSTALLED flint-chart's channel
// list. A gallery that demonstrates an undeclared channel teaches the exact mistake the
// chart-authoring skill exists to prevent.
export const SPECS: [Spec, ...Spec[]] = [
  // Points
  { chart: 'Scatter Plot', category: 'Points', data: 'points', encodings: { x: f('spend'), y: f('conversions'), color: f('channel'), size: f('impressions') } },
  { chart: 'Regression', category: 'Points', data: 'points', encodings: { x: f('spend'), y: f('conversions'), color: f('channel') } },
  { chart: 'Connected Scatter Plot', category: 'Points', data: 'ohlc', encodings: { x: f('open'), y: f('close'), order: f('day') } },
  { chart: 'Ranged Dot Plot', category: 'Points', data: 'paired', encodings: { x: f('value'), y: f('segment'), color: f('phase') }, note: 'Takes no column/row facets.' },
  { chart: 'Strip Plot', category: 'Points', data: 'dist', encodings: { x: f('value'), y: f('cohort'), color: f('cohort') } },

  // Bars
  { chart: 'Bar Chart', category: 'Bars', data: 'sales', encodings: { x: f('region'), y: f('revenue', 'sum'), color: f('region') }, note: 'Flint does not aggregate by default — `sum` is what collapses the 16 rows to 4 bars.' },
  { chart: 'Grouped Bar Chart', category: 'Bars', data: 'sales', encodings: { x: f('quarter'), y: f('revenue', 'sum'), group: f('region') }, note: 'Takes `group`, NOT `color`. Passing `color` here silently overplots one bar per quarter.' },
  { chart: 'Stacked Bar Chart', category: 'Bars', data: 'sales', encodings: { x: f('quarter'), y: f('revenue', 'sum'), color: f('region') } },
  { chart: 'Lollipop Chart', category: 'Bars', data: 'sales', encodings: { x: f('region'), y: f('units', 'sum'), color: f('region') } },
  { chart: 'Waterfall Chart', category: 'Bars', data: 'waterfall', encodings: { x: f('step'), y: f('delta') } },
  { chart: 'Gantt Chart', category: 'Bars', data: 'tasks', encodings: { y: f('task'), x: f('start'), x2: f('end'), color: f('team') } },
  { chart: 'Bullet Chart', category: 'Bars', data: 'targets', encodings: { y: f('segment'), x: f('value'), goal: f('target') } },

  // Distributions
  { chart: 'Histogram', category: 'Distributions', data: 'dist', encodings: { x: f('value'), color: f('cohort') } },
  { chart: 'Density Plot', category: 'Distributions', data: 'dist', encodings: { x: f('value'), color: f('cohort') } },
  { chart: 'ECDF Plot', category: 'Distributions', data: 'dist', encodings: { x: f('value'), color: f('cohort') } },
  { chart: 'Violin Plot', category: 'Distributions', data: 'dist', encodings: { x: f('cohort'), y: f('value'), color: f('cohort') } },
  { chart: 'Boxplot', category: 'Distributions', data: 'dist', encodings: { x: f('cohort'), y: f('value'), color: f('cohort') } },
  { chart: 'Pyramid Chart', category: 'Distributions', data: 'pyramid', encodings: { x: f('count'), y: f('age'), color: f('gender') } },
  { chart: 'Candlestick Chart', category: 'Distributions', data: 'ohlc', encodings: { x: f('day'), open: f('open'), high: f('high'), low: f('low'), close: f('close') } },

  // Lines & Areas
  { chart: 'Line Chart', category: 'Lines & Areas', data: 'trend', encodings: { x: f('month'), y: f('users'), color: f('region') }, note: '`month` is an ISO string; only `semantic_types: {month: "Date"}` makes the axis temporal rather than alphabetical.' },
  { chart: 'Sparkline', category: 'Lines & Areas', data: 'trend', encodings: { x: f('month'), y: f('users'), color: f('region') } },
  { chart: 'Bump Chart', category: 'Lines & Areas', data: 'ranks', encodings: { x: f('year'), y: f('rank'), color: f('team') } },
  { chart: 'Slope Chart', category: 'Lines & Areas', data: 'paired', encodings: { x: f('phase'), y: f('value'), color: f('segment') } },
  { chart: 'Area Chart', category: 'Lines & Areas', data: 'trend', encodings: { x: f('month'), y: f('users'), color: f('region') } },
  { chart: 'Streamgraph', category: 'Lines & Areas', data: 'trend', encodings: { x: f('month'), y: f('users'), color: f('region') } },
  { chart: 'Range Area Chart', category: 'Lines & Areas', data: 'band', encodings: { x: f('month'), y: f('lo'), y2: f('hi') } },

  // Circular
  { chart: 'Pie Chart', category: 'Circular', data: 'sales', encodings: { size: f('revenue', 'sum'), color: f('region') }, note: 'No x/y — a pie takes `size` and `color`.' },
  { chart: 'Donut Chart', category: 'Circular', data: 'sales', encodings: { size: f('revenue', 'sum'), color: f('region') } },
  { chart: 'Rose Chart', category: 'Circular', data: 'sales', encodings: { x: f('quarter'), y: f('revenue', 'sum'), color: f('quarter') } },
  { chart: 'Radar Chart', category: 'Circular', data: 'sales', encodings: { x: f('quarter'), y: f('revenue', 'sum'), color: f('region') } },

  // Tables & Maps
  { chart: 'Heatmap', category: 'Tables & Maps', data: 'sales', encodings: { x: f('quarter'), y: f('region'), color: f('revenue', 'sum') } },
  { chart: 'Bar Table', category: 'Tables & Maps', data: 'sales', encodings: { y: f('region'), x: f('revenue', 'sum'), color: f('region') } },
  { chart: 'KPI Card', category: 'Tables & Maps', data: 'kpi', encodings: { metric: f('metric'), value: f('value'), goal: f('goal') } },
  { chart: 'Map', category: 'Tables & Maps', data: 'cities', encodings: { longitude: f('lon'), latitude: f('lat'), size: f('pop'), color: f('pop') } },
];

const CATEGORIES = ['Points', 'Bars', 'Distributions', 'Lines & Areas', 'Circular', 'Tables & Maps'];

/* ── the card ───────────────────────────────────────────────────────────── */

const BG = '#11141a';
const HEAD = '#0d1017';
const LINE = '#2a2e3d';
const TEXT = '#c9cdd6';
const MUTED = '#7a7f8c';

export default function FlintGallery({
  chart = 'Grouped Bar Chart',
  showSpec = true,
  accent = '#4a9eff',
  setData,
}: {
  chart?: string;
  showSpec?: boolean;
  accent?: string;
  setData?: (patch: { chart?: string; showSpec?: boolean }) => void;
}) {
  // The host injects `setData`, and a pick then arrives back as a new `chart` prop —
  // synced to collaborators and surviving reload. Local state is only the fallback for
  // rendering outside a shape (a test harness, a story), where no host echoes it back.
  const [localChart, setLocalChart] = useState(chart);
  const [localSpec, setLocalSpec] = useState(showSpec);
  const selected = setData ? chart : localChart;
  const specOpen = setData ? showSpec : localSpec;

  const active = SPECS.find((s) => s.chart === selected) ?? SPECS[0];
  const d = DATA[active.data];

  const pick = (name: string) => {
    setLocalChart(name);
    setData?.({ chart: name });
  };
  const toggleSpec = () => {
    setLocalSpec(!specOpen);
    setData?.({ showSpec: !specOpen });
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        background: BG,
        color: TEXT,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '8px 12px',
          background: HEAD,
          borderBottom: `1px solid ${LINE}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={toggleSpec}
          style={{
            font: 'inherit',
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            border: `1px solid ${specOpen ? accent : LINE}`,
            background: specOpen ? `${accent}22` : 'transparent',
            color: specOpen ? accent : MUTED,
          }}
        >
          spec
        </button>
        <strong style={{ fontSize: 13 }}>{active.chart}</strong>
        <span style={{ color: MUTED }}>{active.category}</span>
        <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 11 }}>
          {SPECS.length} chart types · flint-chart
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav
          aria-label="Chart types"
          style={{ width: 168, flexShrink: 0, overflowY: 'auto', borderRight: `1px solid ${LINE}`, padding: '6px 0' }}
        >
          {CATEGORIES.map((cat) => (
            <div key={cat}>
              <div style={{ padding: '8px 10px 3px', color: MUTED, fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase' }}>
                {cat}
              </div>
              {SPECS.filter((s) => s.category === cat).map((s) => {
                const on = s.chart === active.chart;
                return (
                  <button
                    key={s.chart}
                    type="button"
                    onClick={() => pick(s.chart)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      font: 'inherit',
                      fontSize: 11.5,
                      padding: '3px 10px',
                      cursor: 'pointer',
                      border: 'none',
                      borderLeft: `2px solid ${on ? accent : 'transparent'}`,
                      background: on ? `${accent}1a` : 'transparent',
                      color: on ? '#fff' : TEXT,
                    }}
                  >
                    {s.chart}
                  </button>
                );
              })}
            </div>
          ))}
          <div style={{ padding: '10px 10px 4px', color: MUTED, fontSize: 10, lineHeight: 1.5 }}>
            Choropleth is the one type Flint ships that is not here — it keys marks to a
            geography id space, which inline rows cannot supply.
          </div>
        </nav>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            {/* Remount per chart type: ChartCard assembles its Vega view in an effect keyed
                on size, and swapping chart type under a live view leaves the old marks. */}
            <ChartCard
              key={active.chart}
              chartType={active.chart}
              encodings={active.encodings}
              semantic_types={d.types}
              values={d.values}
              title={`${active.chart} — ${active.data}`}
            />
          </div>

          {specOpen ? (
            <div style={{ flexShrink: 0, maxHeight: '46%', overflowY: 'auto', borderTop: `1px solid ${LINE}`, background: HEAD }}>
              {active.note ? (
                <div style={{ padding: '7px 12px 0', color: '#e0af68', fontSize: 11, lineHeight: 1.5 }}>{active.note}</div>
              ) : null}
              <pre
                style={{
                  margin: 0,
                  padding: '8px 12px 10px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11,
                  lineHeight: 1.55,
                  color: MUTED,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {placeCall(active, d)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The `place_component` call that reproduces the chart on screen — copy-pasteable. */
function placeCall(s: Spec, d: { values: Array<Record<string, unknown>>; types: Record<string, string> }): string {
  const j = (v: unknown) => JSON.stringify(v);
  const used = new Set(Object.values(s.encodings).map((e) => e.field));
  const types = Object.fromEntries(Object.entries(d.types).filter(([k]) => used.has(k)));
  return [
    'place_component(module="ChartCard", w=600, h=380, data={',
    `  chartType: ${j(s.chart)},`,
    `  encodings: ${j(s.encodings)},`,
    `  semantic_types: ${j(types)},`,
    `  values: [ ${j(d.values[0])}, … ${d.values.length} rows ]`,
    '})',
  ].join('\n');
}
