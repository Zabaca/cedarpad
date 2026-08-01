/**
 * ChartCard renders inside a real tldraw shape.
 *
 * The unit tests prove the guard logic and a standalone page proves Flint→Vega-Lite→SVG,
 * but neither exercises the thing that actually differs on a canvas: the component runs
 * inside a CSS-transformed, user-resizable shape whose host injects props and whose pointer
 * guards decide what reaches it. This is the hop those miss.
 *
 * Every layer is the real one — real edge gate, real bridge `place_component`, real
 * Durable-Object room, real signed-in browser, real vite-compiled component.
 *
 * Gotcha inherited from #305 (see canvas-chat-agent-writes.spec.ts): the pad is selected by
 * PATH, not `?canvas=` — a `?canvas=` URL silently lands on `default`.
 */
import { OWNER_STATE, expect, test } from '../fixtures/test.ts';

const BRIDGE = `http://localhost:${process.env.CANVAS_BRIDGE_PORT}`;

test.use({ storageState: OWNER_STATE });

const VALUES = [
  { region: 'North', qtr: 'Q1', revenue: 120 },
  { region: 'North', qtr: 'Q2', revenue: 180 },
  { region: 'South', qtr: 'Q1', revenue: 90 },
  { region: 'South', qtr: 'Q2', revenue: 150 },
  { region: 'West', qtr: 'Q1', revenue: 200 },
  { region: 'West', qtr: 'Q2', revenue: 170 },
];

test('a placed ChartCard draws a real chart inside its shape', async ({ page, owner, request }) => {
  const created = await owner.post('/api/canvases', { data: { name: `chart-card-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });

  const placed = await request.post(`${BRIDGE}/api/components/place`, {
    headers: { 'x-canvas-id': canvasId, 'content-type': 'application/json' },
    data: {
      module: 'ChartCard',
      x: 100,
      y: 100,
      w: 600,
      h: 380,
      data: {
        title: 'Revenue by quarter',
        chartType: 'Grouped Bar Chart',
        encodings: { x: { field: 'qtr' }, y: { field: 'revenue' }, group: { field: 'region' } },
        semantic_types: { region: 'Category', qtr: 'Quarter', revenue: 'Price' },
        values: VALUES,
      },
    },
  });
  expect(placed.ok()).toBeTruthy();

  // The chart itself, not merely the card: vega renders marks into an SVG inside the shape.
  const chart = page.locator('.tl-shape svg').first();
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tl-shape svg path').first()).toBeVisible();

  // Flint derived the chrome the agent never wrote — a legend from `group`, axis labels
  // from the data. Their absence is exactly the silent-wrong render the guard exists for.
  const shape = page.locator('.tl-shape', { hasText: 'Revenue by quarter' }).first();
  for (const label of ['North', 'South', 'West', 'Q1', 'Q2']) {
    await expect(shape).toContainText(label);
  }
});

test('an undeclared channel is reported instead of silently drawn', async ({ page, owner, request }) => {
  const created = await owner.post('/api/canvases', { data: { name: `chart-card-guard-${Date.now()}` } });
  const canvasId = ((await created.json()) as { id: string }).id;

  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });

  // `color` is not a Grouped Bar Chart channel. Flint DROPS it silently and would render a
  // plain bar chart with the three regions overplotted — a confident lie. The card must say so.
  const placed = await request.post(`${BRIDGE}/api/components/place`, {
    headers: { 'x-canvas-id': canvasId, 'content-type': 'application/json' },
    data: {
      module: 'ChartCard',
      x: 100,
      y: 100,
      w: 600,
      h: 380,
      data: {
        title: 'Wrong channel',
        chartType: 'Grouped Bar Chart',
        encodings: { x: { field: 'qtr' }, y: { field: 'revenue' }, color: { field: 'region' } },
        semantic_types: { region: 'Category', qtr: 'Quarter', revenue: 'Price' },
        values: VALUES,
      },
    },
  });
  expect(placed.ok()).toBeTruthy();

  const shape = page.locator('.tl-shape', { hasText: 'Wrong channel' }).first();
  await expect(shape).toContainText('has no "color" channel', { timeout: 30_000 });
  await expect(shape).toContainText('group');
});
