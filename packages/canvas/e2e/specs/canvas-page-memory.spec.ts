/**
 * A reload lands back on the page you were on, with that page's camera.
 *
 * This is a reload bug, so no unit test can honestly cover it: what was broken is that
 * `currentPageId` lives in tldraw's `session` scope, which `useSync` does not persist and no
 * `persistenceKey` covers, so every reload opened page one. Only a real second page load
 * exercises that.
 *
 * Both assertions read through the editor (`window.__canvasEditor`, the dev-only seam
 * `canvas-ui-drag.spec.ts` established) rather than through pixels — the page switcher's
 * label would tell us what the UI says, not what the editor actually restored.
 *
 * Gotcha inherited from #305 / #292 / #310: the pad is selected by PATH. A `?canvas=` query
 * silently lands on `default`.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

test.use({ storageState: OWNER_STATE });

async function openPad(page: import('@playwright/test').Page, canvasId: string) {
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000); // let the sync session connect before reading the document
}

test('a reload returns to the page you were on, with that page camera', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `page-memory-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  await openPad(page, canvasId);

  // A second page, switched to, with a camera position that is unmistakably not the default.
  const secondPageId = await page.evaluate(() => {
    const e = (window as any).__canvasEditor;
    e.createPage({ name: 'Second' });
    const second = e.getPages()[1];
    e.setCurrentPage(second.id);
    e.setCamera({ x: -1234, y: -567, z: 1 }, { immediate: true });
    return second.id as string;
  });
  await page.waitForTimeout(600); // the view is saved on a 200ms debounce off the session listener

  // Wait for the ROOM to hold the new page before reloading. The restore looks the remembered
  // id up among the pages the document came back with, so a reload that beats the page's own
  // sync finds nothing to restore and lands on page one — a race this spec lost intermittently
  // while asserting nothing about the behaviour under test.
  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        const state = (await read.json()) as { pages?: Array<{ id: string }> };
        return (state.pages ?? []).map((p) => p.id);
      },
      { timeout: 15_000 },
    )
    .toContain(secondPageId);

  await openPad(page, canvasId);

  expect(await page.evaluate(() => (window as any).__canvasEditor.getCurrentPageId() as string)).toBe(secondPageId);

  // The camera is per PAGE in tldraw. A camera map keyed only by canvas would restore page
  // one's viewport here — the right page showing the wrong place, which still reads as
  // "it lost my place".
  const cam = await page.evaluate(() => (window as any).__canvasEditor.getCamera() as { x: number; y: number });
  expect(Math.round(cam.x)).toBe(-1234);
  expect(Math.round(cam.y)).toBe(-567);
});
