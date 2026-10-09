---
name: chart-authoring
description: Put a data chart on the canvas. Use whenever the human asks to chart, plot, graph, or visualize numbers, or wants a trend, comparison, breakdown, distribution, or correlation shown. Covers the ChartCard component and its Flint spec.
---

# Charting on the canvas

**Never hand-draw a chart.** Place the platform `ChartCard` and give it a spec. It compiles
through Flint (`flint-chart`) to Vega-Lite and renders SVG, deriving scales, axes, gridlines,
legend, colors and layout from your data. You write intent, not geometry.

```
place_component(module="ChartCard", x=…, y=…, w=600, h=380, data={
  title: "Revenue by quarter",
  chartType: "Grouped Bar Chart",
  encodings: { x: {field:"qtr"}, y: {field:"revenue"}, group: {field:"region"} },
  semantic_types: { qtr: "Quarter", revenue: "Price", region: "Category" },
  values: [ {qtr:"Q1", region:"North", revenue:120}, … ]
})
```

Write your own component only if no chart type below fits.

## The three ways this goes wrong

Flint fails **silently and visually** — it renders a confident, wrong chart rather than raising.
All three of these produce a picture that looks fine and isn't.

### 1. A channel the chart type doesn't declare is DROPPED

`Grouped Bar Chart` takes `group`, not `color`. Pass `color` and the series collapse into one
overplotted bar per category — no error. ChartCard now catches this and shows the valid
channels instead of drawing, but that costs you a turn. **Look the chart type up in the table
below before writing the encodings.**

### 2. Rows are charted RAW unless you aggregate

Flint does not aggregate by default. Point a chart at thousands of rows and you get thousands
of marks. Put `aggregate` on the measure channel:

```
encodings: { x: {field:"region"}, y: {field:"revenue", aggregate:"sum"} }
```

`sum`, `mean`, `median`, `min`, `max`, `count`. Aggregation happens client-side over every row
you pass, so for a large dataset prefer `values` that are *already* the summary.

### 3. `semantic_types` is what types the axis — not the JS value

Dates usually arrive as **ISO strings**. Flint types the axis from `semantic_types`, not from
the runtime type, so a date column still needs `"Date"` (→ temporal axis) and a numeric
column still needs `"Quantity"`/`"Price"` (→ quantitative). Omit them and you get a categorical
axis over date strings, sorted alphabetically.

Common semantic types: `Quantity`, `Price`, `Percentage`, `Count`, `Rank`, `Category`, `Date`,
`Year`, `Quarter`, `Month`, `Country`, `Duration`, `Temperature`. There are 70+; a plausible name
usually resolves.

## Sizing

`w=600, h=380` is a good default. Smaller than about 320×240 and Flint drops tick labels to fit.
The chart re-derives its layout when the human resizes the card, so pick a shape, not a pixel count.

## Chart types and their channels

This table is the authority — it is generated from the installed `flint-chart`, so it cannot
drift. Most types accept `column`/`row` for faceting, but not all (e.g. `Map`, `KPI Card`,
`Ranged Dot Plot`); use only what a row lists.

<!-- BEGIN GENERATED -->
| Chart type | Category | Channels |
| --- | --- | --- |
| Scatter Plot | Points | `x`, `y`, `color`, `size`, `shape`, `opacity`, `column`, `row` |
| Regression | Points | `x`, `y`, `size`, `color`, `column`, `row` |
| Connected Scatter Plot | Points | `x`, `y`, `order`, `color`, `detail`, `column`, `row` |
| Ranged Dot Plot | Points | `x`, `y`, `color` |
| Strip Plot | Points | `x`, `y`, `color`, `size`, `column`, `row` |
| Bar Chart | Bars | `x`, `y`, `color`, `opacity`, `column`, `row` |
| Grouped Bar Chart | Bars | `x`, `y`, `group`, `column`, `row` |
| Stacked Bar Chart | Bars | `x`, `y`, `color`, `column`, `row` |
| Lollipop Chart | Bars | `x`, `y`, `color`, `column`, `row` |
| Waterfall Chart | Bars | `x`, `y`, `color`, `column`, `row` |
| Gantt Chart | Bars | `y`, `x`, `x2`, `color`, `detail`, `column`, `row` |
| Bullet Chart | Bars | `y`, `x`, `goal`, `color`, `column`, `row` |
| Histogram | Distributions | `x`, `color`, `column`, `row` |
| Density Plot | Distributions | `x`, `color`, `column`, `row` |
| ECDF Plot | Distributions | `x`, `color`, `detail`, `column`, `row` |
| Violin Plot | Distributions | `x`, `y`, `color`, `row` |
| Boxplot | Distributions | `x`, `y`, `color`, `opacity`, `column`, `row` |
| Pyramid Chart | Distributions | `x`, `y`, `color` |
| Candlestick Chart | Distributions | `x`, `open`, `high`, `low`, `close`, `column`, `row` |
| Line Chart | Lines & Areas | `x`, `y`, `color`, `strokeDash`, `detail`, `opacity`, `column`, `row` |
| Sparkline | Lines & Areas | `x`, `y`, `color`, `detail`, `row`, `column` |
| Bump Chart | Lines & Areas | `x`, `y`, `color`, `detail`, `column`, `row` |
| Slope Chart | Lines & Areas | `x`, `y`, `color`, `detail`, `column`, `row` |
| Area Chart | Lines & Areas | `x`, `y`, `color`, `opacity`, `column`, `row` |
| Streamgraph | Lines & Areas | `x`, `y`, `color`, `column`, `row` |
| Range Area Chart | Lines & Areas | `x`, `y`, `y2`, `color`, `column`, `row` |
| Pie Chart | Circular | `size`, `color`, `column`, `row` |
| Donut Chart | Circular | `size`, `color`, `column`, `row` |
| Rose Chart | Circular | `x`, `y`, `color`, `column`, `row` |
| Radar Chart | Circular | `x`, `y`, `color`, `column`, `row` |
| Heatmap | Tables & Maps | `x`, `y`, `color`, `column`, `row` |
| Bar Table | Tables & Maps | `y`, `x`, `color`, `column`, `row` |
| KPI Card | Tables & Maps | `metric`, `value`, `goal` |
| Map | Tables & Maps | `longitude`, `latitude`, `color`, `size`, `opacity` |
| Choropleth | Tables & Maps | `id`, `color`, `detail` |
<!-- END GENERATED -->

Regenerate this table with `bun run scripts/gen-chart-skill.ts` after bumping `flint-chart`.
