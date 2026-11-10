// Sizing a Flint chart to its card. Lives OUTSIDE ChartCard.tsx on purpose: React Fast
// Refresh only patches a module whose exports are all components, so a helper exported from
// ChartCard.tsx downgraded every edit of it to a FULL PAGE RELOAD of the canvas.

/** Vega-Lite composition keys. A spec carrying one of these is a facet/concat/repeat, and
 *  Vega-Lite refuses `autosize: fit` on those — it warns and renders unsized. */
const MULTI_VIEW = ['facet', 'spec', 'concat', 'hconcat', 'vconcat', 'repeat'] as const;

/**
 * Size the chart to the card.
 *
 * Flint takes our `baseSize` and does the layout maths — for an 876×372 box it works out a
 * 636×322 plot, reserving the rest for the axis gutter and title — but it parks the answer
 * on `_width`/`_height`. Vega-Lite ignores underscore-prefixed keys, so the spec reached it
 * with NO size at all and it fell back to its own default. That is why a chart drew at
 * roughly 646×322 no matter how large the card was: it was never told.
 *
 * So set the size here, from the container rather than from Flint's `_width`: with
 * `autosize: fit` the width/height become the OUTER box and Vega-Lite shrinks the plot until
 * axes, title and legend fit inside it. That makes the fit exact instead of dependent on
 * Flint's estimate of its own chrome, and `contains: 'padding'` keeps the padding in too.
 *
 * Exported for test. The guard is the interesting part: Vega-Lite refuses `fit` on a
 * composition, so asking is not merely useless there — it drops the size it was given.
 */
export function applyFit(spec: Record<string, unknown>, width: number, height: number): void {
  if (MULTI_VIEW.some((k) => k in spec)) return;
  spec.width = width;
  spec.height = height;
  spec.autosize = { type: 'fit', contains: 'padding' };
}
