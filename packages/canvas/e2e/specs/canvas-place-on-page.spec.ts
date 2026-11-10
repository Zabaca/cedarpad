/**
 * "+ Component" places onto the page you are LOOKING AT, not page one.
 *
 * Reported 2026-08-07: on a second page, adding a component put it on page one.
 *
 * Every unit-level link in this path already passes — `ComponentGallery.test.tsx` proves the
 * request carries `page`, `current-page.test.ts` proves `pageToSend` picks it, and
 * `placeComponentOp` stores it. So whatever is wrong lives between a REAL tldraw editor and
 * that request, which is precisely the seam no unit test reaches: `pageToSend` is handed
 * `editor.getPages()` and `editor.getCurrentPageId()`, and it decides "is this page one?" from
 * their order. Only a real editor with a real second page exercises that.
 *
 * Asserts through the ROOM (what was actually written) rather than through the editor, since
 * the bug is about where the card was STORED — a client that renders it in the right place
 * over a wrong write would still be broken for the next reader.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

test.use({ storageState: OWNER_STATE });

test('a component added while page two is open lands on page two', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `place-on-page-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000); // let the sync session connect before touching the document

  // A second page, switched to — the state the bug needs.
  const secondPageId = await page.evaluate(() => {
    const e = (window as any).__canvasEditor;
    e.createPage({ name: 'Second' });
    const second = e.getPages()[1];
    e.setCurrentPage(second.id);
    return second.id as string;
  });

  // The room has to hold the page before we place onto it, else the write races the page's
  // own sync — the same race canvas-page-memory.spec.ts documents.
  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        return (((await read.json()) as { pages?: Array<{ id: string }> }).pages ?? []).map((p) => p.id);
      },
      { timeout: 15_000 },
    )
    .toContain(secondPageId);

  // The reported path, clicked rather than simulated: "+ Component" → pick one.
  // Scoped by CONTAINER, not by class alone: the Huddle control reuses `.side-panel-add`
  // (SidePanel.tsx:108), so a bare class selector clicks Huddle and this spec fails for a reason
  // that has nothing to do with pages. Not by label either — the button reads "＋ Component" with
  // a FULLWIDTH plus, so an ASCII "+ Component" never matches.
  await page.click('.side-panel-actions .side-panel-add');
  // Split from the card wait so a failure says WHICH half broke: the modal not opening and
  // the library not loading look identical through a single `.gallery-card` wait.
  await page.waitForSelector('.gallery', { timeout: 15_000 });
  await page.waitForSelector('.gallery-card', { timeout: 30_000 });
  await page.click('.gallery-card');

  const placed = await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        const state = (await read.json()) as { shapes?: Array<{ type: string; page?: string }> };
        return (state.shapes ?? []).filter((s) => s.type === 'component');
      },
      { timeout: 15_000 },
    )
    .toHaveLength(1)
    .then(async () => {
      const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
      return ((await read.json()) as { shapes: Array<{ type: string; page?: string }> }).shapes.filter((s) => s.type === 'component');
    });

  // ABSENT page means page one (src/current-page.ts), so `undefined` here IS the bug.
  expect(placed[0]?.page).toBe(secondPageId);
});

/**
 * THE REPORTED BUG (2026-08-07): a canvas whose pages have been REORDERED.
 *
 * tldraw sorts pages by its own fractional index, so dragging a page about changes which one
 * leads `getPages()`. The canvas keeps its own order. Once they disagree, the old `pageToSend`
 * — which asked "is `getPages()[0]` the page I am on?" — read the OPEN page as page one, sent
 * no `page`, and the server put the card on ITS first page.
 *
 * Measured in production on an 11-page canvas: `getPages()[0]` and `getCurrentPageId()` were
 * both "Focus" while the canvas's first page was "Page 1". The two tests above cannot catch it
 * because a freshly created page always sorts after page one, so their orders agree.
 */
test('a component lands on the open page even when that page sorts first in the editor', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `place-reordered-${Date.now()}` } });
  const canvasId = ((await created.json()) as { id: string }).id;

  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000);

  const ids = await page.evaluate(() => {
    const e = (window as any).__canvasEditor;
    const firstPageId = e.getPages()[0].id as string;
    e.createPage({ name: 'Focus' });
    const focus = e.getPages().find((p: any) => p.name === 'Focus');
    // Drag it to the front, which is what a human reordering pages does.
    e.updatePage({ id: focus.id, index: 'a0' });
    e.setCurrentPage(focus.id);
    return { focus: focus.id as string, firstPageId, editorFirst: e.getPages()[0].id as string };
  });

  // The precondition the bug needs — if this ever stops holding, the test below proves nothing.
  expect(ids.editorFirst).toBe(ids.focus);
  expect(ids.focus).not.toBe(ids.firstPageId);

  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        return (((await read.json()) as { pages?: Array<{ id: string }> }).pages ?? []).map((p) => p.id);
      },
      { timeout: 15_000 },
    )
    .toContain(ids.focus);

  let sent: string | null = null;
  page.on('request', (r) => {
    if (r.url().includes('/api/components/place')) sent = r.postData();
  });

  await page.click('.side-panel-actions .side-panel-add');
  await page.waitForSelector('.gallery', { timeout: 15_000 });
  await page.waitForSelector('.gallery-card', { timeout: 30_000 });
  await page.click('.gallery-card');
  await page.waitForTimeout(1500);
  // THE REGRESSION GUARD. The request must NAME the open page rather than leaving it to be
  // inferred — that inference is the bug, and it is the only part of this that a reordered
  // canvas can be relied on to exercise. Asserting on where the shape ends up cannot stand in
  // for it: a shape on the room's FIRST page is stored in canonical form (absent `page`), so a
  // correct placement and a placement that fell back to page one look identical from a read.
  expect(sent).not.toBeNull();
  expect(JSON.parse(sent as unknown as string)).toMatchObject({ page: ids.focus });

  // …and it does land on the open page, read through the same rule the model uses: absent
  // means the room's first page (src/current-page.ts).
  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        const st = (await read.json()) as { pages?: Array<{ id: string }>; shapes?: Array<{ type: string; page?: string }> };
        const roomFirst = st.pages?.[0]?.id;
        return (st.shapes ?? []).filter((s) => s.type === 'component').map((s) => s.page ?? roomFirst);
      },
      { timeout: 15_000 },
    )
    .toEqual([ids.focus]);
});

/**
 * The same thing, but on a page RESTORED by a reload rather than one created in this session.
 *
 * This is the realistic shape of the report: you come back to a canvas, land on the page you
 * were last on, and add a card. It is a different code path from the test above — the page is
 * restored by `restorablePage` after the document syncs, so `editorRef` and the page list are
 * populated in a different order, and `currentPage()` returns `undefined` for a NULL editor,
 * which is indistinguishable from "I am on page one".
 */
test('a component added on a page restored by reload lands on that page', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `place-on-reload-${Date.now()}` } });
  const canvasId = ((await created.json()) as { id: string }).id;

  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000);

  const secondPageId = await page.evaluate(() => {
    const e = (window as any).__canvasEditor;
    e.createPage({ name: 'Second' });
    const second = e.getPages()[1];
    e.setCurrentPage(second.id);
    return second.id as string;
  });
  await page.waitForTimeout(600); // the view is saved on a 200ms debounce

  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        return (((await read.json()) as { pages?: Array<{ id: string }> }).pages ?? []).map((p) => p.id);
      },
      { timeout: 15_000 },
    )
    .toContain(secondPageId);

  // Reload — now the open page is whatever the restore put us on, not one we just set.
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const openPage = await page.evaluate(() => (window as any).__canvasEditor.getCurrentPageId() as string);
  expect(openPage).toBe(secondPageId); // guard: if the restore failed, the rest proves nothing

  await page.click('.side-panel-actions .side-panel-add');
  await page.waitForSelector('.gallery', { timeout: 15_000 });
  await page.waitForSelector('.gallery-card', { timeout: 30_000 });
  await page.click('.gallery-card');

  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        const shapes = ((await read.json()) as { shapes?: Array<{ type: string; page?: string }> }).shapes ?? [];
        return shapes.filter((s) => s.type === 'component').map((s) => s.page ?? 'FIRST_PAGE');
      },
      { timeout: 15_000 },
    )
    .toEqual([secondPageId]);
});
