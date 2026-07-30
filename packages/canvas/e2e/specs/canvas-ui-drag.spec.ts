/**
 * #301, the acceptance test for #285 criterion 1 that nothing before this drove: every
 * existing sync spec (`canvas-room-writes`, `canvas-chat-agent-writes`, `canvas-binding-cleanup`)
 * writes through an HTTP endpoint and only ever WATCHES the tldraw surface. None of them drive
 * it — no spec presses a tool key or drags a pointer across `.tl-canvas`. This one does.
 *
 * Both tests use the real toolbar keyboard shortcuts ('r' selects the rectangle/geo tool,
 * documented in tldraw's own `useTools.tsx`) and real `page.mouse` down/move/up sequences to
 * draw and then drag a shape, exactly as a human would. Positions are asserted through the
 * SYNCED STORE (`editor.getCurrentPageShapes`), not through pixels — tldraw draws to
 * WebGL/canvas and a screenshot diff would be both slower and less honest about what moved.
 *
 * `editor.pageToScreen` / `screenToPage` convert between the shape's coordinate space and the
 * mouse's, so the drag amount asserted is the one the pointer actually travelled, not an
 * assumption about camera zoom. #301 explicitly forbids absolute timing thresholds; nothing
 * here asserts on frame time, only on the eventual state.
 *
 * Gotcha inherited from #305 / #292 / #310: the pad is selected by PATH. A `?canvas=` query
 * silently lands on `default`.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

test.use({ storageState: OWNER_STATE });

interface PagePoint {
  x: number;
  y: number;
}

interface GeoShapeRecord {
  id: string;
  type: string;
  x: number;
  y: number;
}

/** Convert a page-space point to a viewport-space point Playwright's mouse can target. */
async function toScreenPoint(page: import('@playwright/test').Page, pagePoint: PagePoint): Promise<PagePoint> {
  const screenRelative = await page.evaluate((p) => (window as any).__canvasEditor.pageToScreen(p), pagePoint);
  const box = await page.locator('.tl-canvas').boundingBox();
  if (!box) throw new Error('.tl-canvas has no bounding box');
  return { x: box.x + screenRelative.x, y: box.y + screenRelative.y };
}

/**
 * Where on the SCREEN this spec is allowed to press the mouse — a band clear of every fixed
 * overlay the pad draws over the canvas: the toolbar (top-left), the properties rail (right),
 * and the chat starter (bottom-center).
 *
 * These were page coordinates (600,600 → 800,750) until #388's first green run. Two things had
 * quietly invalidated them: #347 widened the bottom-center chat control from a ~120px "＋ New
 * chat" button into a 260px prompt, which put `button.chat-starter` directly under the draw's
 * start point, and the end point (y=750) was below the 720px viewport entirely. The pointer
 * pressed on a DOM button instead of the canvas, so no rectangle was ever drawn and every
 * assertion after it failed on an empty store — a broken test that looked like broken sync.
 *
 * Screen-space, not page-space, because what has to be avoided is fixed to the viewport, not
 * to the document. `bareSurface` asserts the band really is bare before each draw, so the next
 * overlay to move fails here with "the draw would land on <element>" rather than downstream.
 */
const DRAW_BAND = { from: { x: 180, y: 220 }, to: { x: 330, y: 340 }, focus: { x: 180, y: 450 } };

/** What the DOM says is at a viewport point — the check that keeps the band honest. */
async function elementAt(page: import('@playwright/test').Page, p: PagePoint): Promise<string> {
  return await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
    return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : 'nothing (outside the viewport)';
  }, [p.x, p.y]);
}

/**
 * Put bare canvas under `DRAW_BAND` and prove it is bare.
 *
 * The pan is scene setup, not the behaviour under test: a canvas is born with a `chat` shape at
 * page (300,130), so drawing near the origin means drawing on a card. Moving the camera far from
 * it leaves the band showing nothing but canvas — while the drawing itself stays what this spec
 * exists for, a real pointer on a real surface.
 */
async function bareSurface(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    (window as any).__canvasEditor.setCamera({ x: -2000, y: -2000, z: 1 });
  });
  await page.waitForTimeout(100);
  for (const [name, point] of Object.entries(DRAW_BAND)) {
    expect(await elementAt(page, point), `the ${name} point of the draw must be bare canvas`).toContain('tl-background');
  }
}

/** The only `geo` (rectangle/ellipse/etc.) shape on the page — the one this spec drew. */
async function readGeoShape(page: import('@playwright/test').Page): Promise<GeoShapeRecord> {
  const shapes = await page.evaluate(
    () =>
      (window as any).__canvasEditor
        .getCurrentPageShapes()
        .filter((s: GeoShapeRecord) => s.type === 'geo')
        .map((s: GeoShapeRecord) => ({ id: s.id, type: s.type, x: s.x, y: s.y })),
  );
  expect(shapes).toHaveLength(1);
  return shapes[0] as GeoShapeRecord;
}

/** Draw a rectangle by dragging the pointer across `DRAW_BAND`, on canvas proven to be bare. */
async function drawRectangle(page: import('@playwright/test').Page) {
  await bareSurface(page);
  const { from: start, to: end, focus } = DRAW_BAND;
  // tldraw's own keyboard shortcuts only fire once the editor container has DOM focus (hence
  // its "Move focus to canvas" a11y skip-link). Focus away from the drag's own start point and
  // pause briefly after — clicking right where the drag begins risks the browser's own
  // double-click detection (time + position, blind to the keypress in between) turning the
  // drag into a click-to-place instead.
  await page.mouse.click(focus.x, focus.y);
  await page.keyboard.press('r'); // the rectangle tool's own shortcut (tldraw useTools.tsx)
  await page.waitForTimeout(200);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
}

/** Select the tool, click the shape at its current center, and drag it by a screen delta. */
async function dragShapeBy(
  page: import('@playwright/test').Page,
  shapeId: string,
  deltaScreen: PagePoint,
): Promise<{ startScreen: PagePoint; endScreen: PagePoint }> {
  await page.keyboard.press('v'); // the select tool's own shortcut
  const bounds = await page.evaluate((id) => (window as any).__canvasEditor.getShapePageBounds(id), shapeId);
  const centerPage = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  const centerScreen = await toScreenPoint(page, centerPage);
  const endScreen = { x: centerScreen.x + deltaScreen.x, y: centerScreen.y + deltaScreen.y };

  await page.mouse.move(centerScreen.x, centerScreen.y);
  await page.mouse.down();
  await page.mouse.move(endScreen.x, endScreen.y, { steps: 10 });
  await page.mouse.up();
  return { startScreen: centerScreen, endScreen };
}

test('drawing a rectangle and dragging it updates the synced store, and the move survives a reload', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `ui-drag-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000); // let the sync session connect before drawing into it

  // 1) Create: a real toolbar shortcut + a real pointer drag on the canvas surface.
  await drawRectangle(page);
  const created1 = await readGeoShape(page);
  const initial = { x: created1.x, y: created1.y };

  // 2) Move: select it and drag it by a known screen delta.
  const dragDelta = { x: 220, y: 140 };
  const { startScreen, endScreen } = await dragShapeBy(page, created1.id, dragDelta);

  // The page-space delta the pointer actually travelled — not an assumed zoom of 1.
  const [startPage, endPage] = await page.evaluate(
    ([a, b]) => [(window as any).__canvasEditor.screenToPage(a), (window as any).__canvasEditor.screenToPage(b)],
    [startScreen, endScreen],
  );
  const expectedDelta = { x: endPage.x - startPage.x, y: endPage.y - startPage.y };

  const moved = await readGeoShape(page);
  // Assert the store's own record, not pixels: it moved by the amount the pointer travelled,
  // in page space, with tolerance for the grab-point-vs-shape-origin difference above.
  expect(moved.x - initial.x).toBeCloseTo(expectedDelta.x, -1);
  expect(moved.y - initial.y).toBeCloseTo(expectedDelta.y, -1);
  expect(moved.id).toBe(created1.id);

  // Give the drag's own delta a moment to reach the room before reloading — otherwise the
  // reload can race the outgoing sync message and this would prove nothing about the room.
  await expect
    .poll(
      async () => {
        const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
        const state = (await read.json()) as { shapes: Array<{ id: string; x: number }> };
        return state.shapes.find((s) => s.id === created1.id)?.x;
      },
      { timeout: 15_000 },
    )
    .toBeCloseTo(moved.x, 0);

  // 3) Persist: reload and the room — not the tab's local editor state — must agree.
  await page.reload();
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  const reloaded = await readGeoShape(page);
  expect(reloaded.x).toBeCloseTo(moved.x, 0);
  expect(reloaded.y).toBeCloseTo(moved.y, 0);

  // And the room agrees too, read back through the edge as the owner — the same
  // cross-check `canvas-room-writes.spec.ts` uses.
  const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
  const state = (await read.json()) as { shapes: Array<{ id: string; x: number; y: number }> };
  const roomShape = state.shapes.find((s) => s.id === created1.id);
  expect(roomShape).toBeDefined();
  expect(roomShape?.x).toBeCloseTo(moved.x, 0);
  expect(roomShape?.y).toBeCloseTo(moved.y, 0);
});

test('two browsers on one canvas: dragging a shape in A moves it live in B', async ({ browser, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `ui-drag-fanout-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;
  const pad = `/w/default/canvas/${canvasId}/pad`;

  const contextA = await browser.newContext({ storageState: OWNER_STATE });
  const contextB = await browser.newContext({ storageState: OWNER_STATE });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto(pad);
    await p.waitForSelector('.tl-canvas', { timeout: 30_000 });
  }
  await pageA.waitForTimeout(2000); // let both sync sessions connect before A draws

  // A draws the rectangle with a real pointer drag.
  await drawRectangle(pageA);
  const drawnInA = await readGeoShape(pageA);

  // B, which never touched a tool or a mouse, converges on the same shape via the room —
  // live, over the socket, not by reloading.
  await expect
    .poll(
      async () =>
        (
          await pageB.evaluate(() => (window as any).__canvasEditor.getCurrentPageShapes().filter((s: GeoShapeRecord) => s.type === 'geo'))
        ).length,
      { timeout: 20_000 },
    )
    .toBe(1);
  const seenByB = await readGeoShape(pageB);
  expect(seenByB.id).toBe(drawnInA.id);
  expect(seenByB.x).toBeCloseTo(drawnInA.x, 0);
  expect(seenByB.y).toBeCloseTo(drawnInA.y, 0);

  // A drags it; B must see the move live, without a reload — the fan-out ADR-0019 exists for.
  await dragShapeBy(pageA, drawnInA.id, { x: 220, y: 140 });
  const movedInA = await readGeoShape(pageA);
  expect(movedInA.x).not.toBeCloseTo(drawnInA.x, 0);

  await expect.poll(async () => (await readGeoShape(pageB)).x, { timeout: 20_000 }).toBeCloseTo(movedInA.x, 0);
  const movedSeenByB = await readGeoShape(pageB);
  expect(movedSeenByB.y).toBeCloseTo(movedInA.y, 0);

  await contextA.close();
  await contextB.close();
});
