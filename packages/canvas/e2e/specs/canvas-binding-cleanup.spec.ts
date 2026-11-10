/**
 * #292 item 2: the CLIENT side of binding cleanup, which nothing had ever checked.
 *
 * Sync-core has zero binding logic (ADR-0019), so a binding whose target no longer exists
 * is not cleaned up for us — it is handed straight to every browser in the room. The
 * server sweep in `worker/canvas-mutate.ts` is what prevents that, and this is the only
 * test that watches a REAL browser while the sweep happens: an agent deletes a bound shape
 * out from under a live canvas, and the page must neither throw nor lose the arrow.
 *
 * Two moments are distinct and both matter:
 *   - LIVE: the delta arrives over the socket while the editor is mounted.
 *   - COLD: the reload loads the room from scratch. A dangler survives the socket far more
 *     easily than it survives a cold load, which is where tldraw validates records.
 *
 * The write leg is `/api/canvas-sync/:id/mutate` — the same `applyMutation` the MCP tools
 * reach, addressed directly so the spec can pin shape ids and bind both terminals.
 *
 * Gotcha inherited from #305: the pad is selected by PATH. A `?canvas=` query lands on
 * `default` and the spec then watches the wrong room.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

test.use({ storageState: OWNER_STATE });

test('an agent deleting a bound shape does not break a watching browser', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `binding-cleanup-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  // Anything the page throws is a failure of this test, not noise: a dangling binding
  // surfaces as an exception out of tldraw's own record validation / arrow geometry.
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const stamp = Date.now();
  const arrowLabel = `bound-arrow-${stamp}`;
  const startId = 'shape:bc-start';
  const endId = 'shape:bc-end';
  const arrowId = 'shape:bc-arrow';

  // Two boxes and one arrow bound at BOTH terminals — the case #292 asked us to decide.
  const wrote = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, {
    data: {
      op: 'upsert',
      shapes: [
        { id: startId, type: 'rectangle', x: 100, y: 100, w: 120, h: 80, color: 'blue', text: `start-${stamp}` },
        { id: endId, type: 'rectangle', x: 400, y: 100, w: 120, h: 80, color: 'green', text: `end-${stamp}` },
        { id: arrowId, type: 'arrow', x1: 220, y1: 140, x2: 400, y2: 140, color: 'black', text: arrowLabel, startShapeId: startId, endShapeId: endId },
      ],
    },
  });
  console.log('BOUND WRITE', wrote.status(), await wrote.text());
  expect(wrote.ok()).toBeTruthy();

  // Only now open the browser, so the first thing it loads is a room WITH bindings.
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await expect(page.getByText(`start-${stamp}`).first()).toBeAttached({ timeout: 20_000 });
  await expect(page.getByText(arrowLabel).first()).toBeAttached({ timeout: 20_000 });
  expect(pageErrors).toEqual([]);

  // The agent deletes both bound shapes out from under the live editor.
  const removed = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'remove', ids: [startId, endId] } });
  console.log('REMOVE', removed.status(), await removed.text());
  expect(removed.ok()).toBeTruthy();

  // LIVE: the boxes go, the arrow stays (the both-ends decision, seen from the browser).
  await expect(page.getByText(`start-${stamp}`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(`end-${stamp}`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(arrowLabel).first()).toBeAttached();
  expect(pageErrors).toEqual([]);

  // COLD: reload and load the swept room from scratch. This is where a binding pointing at
  // a shape that no longer exists would take the whole editor down.
  await page.reload();
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await expect(page.getByText(arrowLabel).first()).toBeAttached({ timeout: 20_000 });
  expect(pageErrors).toEqual([]);

  // And the room agrees: arrow alive, unbound, not one binding record left behind.
  const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
  const state = (await read.json()) as { shapes: Array<Record<string, unknown>> };
  console.log('ROOM', JSON.stringify(state.shapes));
  const arrow = state.shapes.find((s) => s.id === arrowId);
  expect(arrow).toBeDefined();
  expect(arrow?.startShapeId).toBeUndefined();
  expect(arrow?.endShapeId).toBeUndefined();
  // Both bound shapes are gone. Asserted by id rather than by room size: opening the pad
  // seeds a `chat` shape of the client's own, which has nothing to do with this test.
  expect(state.shapes.map((s) => s.id)).not.toContain(startId);
  expect(state.shapes.map((s) => s.id)).not.toContain(endId);
});
