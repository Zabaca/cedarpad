// Data chart. Props (the `data` you place it with) ARE a Flint chart spec:
//   { values, semantic_types, chartType, encodings, title? }
// Flint (flint-chart) compiles that to Vega-Lite; vega renders it as SVG.
//
// Works off EITHER data path: inline `values`, or — when placed with a live `dataSource` —
// the `rows` the host injects.
//
// The agent writes INTENT (a chart type + which field goes on which channel) and Flint
// derives scales, axes, legend, colors and layout from the data + semantic types. So this
// component takes no chart-drawing code. It is the ONLY chart component on the platform tier:
// the hand-rolled `BarChart.tsx` was removed once Flint's Vega-Lite adapter was shipping 35
// templates (Bar, Grouped Bar, Stacked Bar, Histogram among them), so a one-layout card built
// out of divs had nothing left to offer.
//
// SVG (not canvas) on purpose: the card lives inside tldraw's CSS-scale transform, so a
// canvas-rendered chart blurs as you zoom the board while SVG stays crisp.
//
// Colors: chrome follows the cedar tokens (src/styles.css, DESIGN.md) — NEVER hardcoded
// hex, the KpiCard rule. Series colors stay Flint's: they're data, not chrome.
import { assembleVegaLite, vlGetTemplateChannels } from 'flint-chart/vegalite';
import { applyFit } from '../chart-fit';
import { useEffect, useRef, useState } from 'react';
import { View, parse } from 'vega';
import { compile } from 'vega-lite';

type Encoding = { field: string; [k: string]: unknown };

export default function ChartCard({
  values = [],
  rows,
  semantic_types = {},
  chartType = 'Bar Chart',
  encodings = {},
  title,
}: {
  values?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
  semantic_types?: Record<string, string>;
  chartType?: string;
  encodings?: Record<string, Encoding>;
  title?: string;
}) {
  // Two data paths, and the host picks which one arrives (ComponentShape): placed with a
  // live `dataSource` it injects a `rows` prop and the chart is LIVE; placed with static
  // `data` there is no `rows` key at all and inline `values` is the source. So presence —
  // not length — selects: a source that is still loading or empty passes `rows: []`, and
  // charting nothing is the honest render there, not silently falling back to a snapshot.
  const source = rows ?? values;
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // A channel the template doesn't declare is SILENTLY DROPPED by Flint — e.g. `color` on a
  // Grouped Bar Chart (which wants `group`) renders a plain bar chart with the series
  // overplotted and no error. Silent-wrong is the worst failure mode for an agent-authored
  // spec, so name it instead of drawing it.
  const allowed = safeChannels(chartType);
  const unknown = allowed && Object.keys(encodings).filter((c) => !allowed.includes(c));

  useEffect(() => {
    const host = hostRef.current;
    if (!host || unknown === undefined || unknown.length > 0) return;

    let view: View | null = null;
    let raf = 0;
    let alive = true;
    // The size we last drew at. Since #-fit the chart is sized FROM the host, and drawing
    // into the host can change the host — a chart one pixel too tall brings up a scrollbar,
    // which narrows `clientWidth`, which redraws narrower, which drops the scrollbar, which
    // widens it again: an endless redraw loop that reads as the card flickering forever.
    // Redrawing only on a real size change breaks it, whatever the cause of the nudge.
    let lastW = 0;
    let lastH = 0;

    const draw = () => {
      // `clientWidth/Height`, NOT `getBoundingClientRect()`: the card renders inside tldraw's
      // CSS-scaled container, so the bounding rect is POST-transform. At zoom 0.6 it reported
      // 60% of the layout box, Flint laid out a chart that small, and the transform then
      // scaled it back up — so the chart under-filled the card at any zoom below 1 (and
      // overflowed above it). `clientWidth` is pure layout, unaffected by transforms; it is
      // the same reason `scrollToHeading` uses `offsetTop` (cedarpad-component skill).
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!alive || width < 1 || height < 1) return;
      // A sub-pixel settle is not a resize. 2px of slack also absorbs the rounding between
      // the layout box and the SVG vega emits, which is what oscillated.
      if (Math.abs(width - lastW) < 2 && Math.abs(height - lastH) < 2) return;
      lastW = width;
      lastH = height;
      try {
        // Re-assemble (not just resize) on every size change: Flint's auto-layout re-derives
        // label density, rotation and legend placement from the size it is given.
        const spec = assembleVegaLite({
          // Shallow-clone every row: vega tags each datum with a `Symbol(vega_id)` for identity
          // tracking, and shape props arrive FROZEN from the tldraw store — handing them over
          // straight throws "Cannot add property Symbol(vega_id), object is not extensible" and
          // the card renders an error instead of a chart. Cloning here (not in the render body)
          // keeps `source`'s identity stable so the effect doesn't re-fire on every render.
          data: { values: source.map((row) => ({ ...row })) },
          semantic_types,
          chart_spec: { chartType, encodings, baseSize: { width, height }, canvasSize: { width, height } },
        }) as Record<string, unknown>;
        applyCedarTheme(spec, host);
        applyFit(spec, width, height);

        view?.finalize();
        view = new View(parse(compile(spec as never).spec), { renderer: 'svg', container: host, hover: true });
        void view.runAsync();
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    // Debounce: a drag-resize fires continuously and each pass is a full Flint→VL→vega
    // recompile, which is far heavier than a canvas library's incremental resize().
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    ro.observe(host);
    draw();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      view?.finalize();
    };
  }, [source, semantic_types, chartType, encodings, unknown]);

  const message =
    unknown === undefined
      ? `Unknown chart type "${chartType}".`
      : unknown.length > 0
        ? `${chartType} has no ${unknown.map((c) => `"${c}"`).join(', ')} channel. Use: ${allowed?.join(', ')}.`
        : error;

  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', padding: 12, font: '13px ui-sans-serif, system-ui', display: 'flex', flexDirection: 'column' }}>
      {title && <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 8 }}>{title}</div>}
      {message ? (
        <div style={{ color: 'var(--danger)', fontSize: 12, lineHeight: 1.5 }}>{message}</div>
      ) : (
        // `overflow: hidden`, not `auto`: with autosize:fit the chart is drawn to this box,
        // so a scrollbar can only ever be the rounding artefact that used to drive the
        // resize loop — and a scrollbar that appears and disappears on its own is worse
        // than a hairline of a chart clipped.
        <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
      )}
    </div>
  );
}

/** Repaint Flint's chart chrome in the cedar palette. Vega-Lite's default theme is LIGHT —
 * black axis text on an opaque white plot — which reads as a bright rectangle on the pad's
 * dark `--surface`. Series colors are left alone — they're data, not chrome; only axes, legend,
 * title and the background are re-tokened. Vega bakes colors into
 * SVG attributes, so the tokens have to be RESOLVED to real values, not passed as `var(…)`. */
function applyCedarTheme(spec: Record<string, unknown>, host: HTMLElement): void {
  const cs = getComputedStyle(host);
  const token = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const text = token('--text', '#c9cdd6');
  const muted = token('--muted', '#7a7f8c');
  const line = token('--line', '#2a2e3d');

  // Merge INTO each sub-config, never over it: Flint puts its own layout decisions under
  // config.axis (label angle, number format, tick count). Replacing that object wholesale
  // drops them and the chart silently loses its x labels and clips.
  const cfg = (spec.config ?? {}) as Record<string, Record<string, unknown>>;
  const into = (key: string, patch: Record<string, unknown>) => ({ ...(cfg[key] ?? {}), ...patch });

  spec.background = 'transparent';
  spec.config = {
    ...cfg,
    view: into('view', { stroke: 'transparent' }),
    axis: into('axis', { labelColor: muted, titleColor: text, gridColor: line, domainColor: line, tickColor: line }),
    legend: into('legend', { labelColor: muted, titleColor: text }),
    title: into('title', { color: text }),
  };
}

/** Declared channels for a chart type, or undefined if Flint has no such template.
 * Flint answers an unknown chart type with an EMPTY channel list rather than throwing,
 * so "no channels" is how a bad chartType presents — treat it as unknown, otherwise every
 * encoding reads as an undeclared channel and the message points at the wrong mistake. */
function safeChannels(chartType: string): string[] | undefined {
  const channels = vlGetTemplateChannels(chartType);
  return channels.length > 0 ? channels : undefined;
}
