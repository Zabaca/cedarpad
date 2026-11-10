/**
 * #293, the acceptance test for presence over tldraw sync's own presence channel.
 *
 * Two independent browser contexts open the SAME canvas, each opening its own sync
 * session against the canvas's Durable Object. Every hop is the real one: the real edge
 * gate authorizes both upgrades, the real `TLSocketRoom` fans presence out. Nothing here
 * touches the bridge — the heartbeat POST and the SSE presence leg are gone.
 *
 * WHY THE ASSERTIONS READ THE EDITOR: tldraw 5.2.5 draws collaborator cursors onto a
 * <canvas> (`CollaboratorCursorOverlayUtil`, Path2D), so there is no cursor DOM node to
 * query. `editor.getCollaborators()` is the exact input that drawing consumes, and the
 * people face-pile IS asserted through its DOM, since that one renders as elements.
 *
 * BOTH CONTEXTS ARE THE SAME SIGNED-IN USER, deliberately. tldraw sync keeps one
 * `instance_presence` record per SESSION — "each tab, window, or device … including the
 * user's own other tabs" (useSync.ts) — so two contexts are two collaborators. A second
 * distinct account would need a direct D1 membership write, which `joinBridgeWorkspace`
 * documents as a measured source of cross-test flake. The identity→name/color mapping is
 * pinned separately, without a browser, in `src/presence.test.ts`.
 *
 * The pad is selected by PATH. A `?canvas=` URL silently lands on `default`.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

test.use({ storageState: OWNER_STATE });

/** What the collaborator machinery has to draw: one entry per other live session. */
type Collaborator = { userName: string; color: string; cursor: { x: number; y: number } | null };

/** Read the collaborators the editor would draw, from inside the page. */
const readCollaborators = () => {
  const e = (window as any).__canvasEditor;
  return e
    ? (e.getCollaborators() as Array<{ userName: string; color: string; cursor: unknown }>).map((c) => ({
        userName: c.userName,
        color: c.color,
        cursor: c.cursor,
      }))
    : [];
};

test('two browsers on one canvas see each other as live collaborators', async ({ browser, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `presence-${Date.now()}` } });
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

  // Both sessions are in the room before either cursor is asserted: a mouse move made
  // before the socket is live is simply not in anyone's presence yet.
  for (const p of [pageA, pageB]) {
    await expect.poll(async () => (await p.evaluate(readCollaborators)).length, { timeout: 30_000 }).toBe(1);
  }

  // 1) Cursors, names and colors. Each browser puts its pointer somewhere distinct; the
  // OTHER browser must see that exact page point, which is what proves the direction of
  // travel (an echo of one's own cursor would report one's own point).
  await pageA.mouse.move(300, 300);
  await pageB.mouse.move(600, 420);

  const seenBy = async (p: typeof pageA) => {
    await expect
      .poll(async () => (await p.evaluate(readCollaborators)) as Collaborator[], { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({
          userName: 'E2E User',
          color: expect.stringMatching(/^hsl\(/),
          cursor: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        }),
      ]);
    return ((await p.evaluate(readCollaborators)) as Collaborator[])[0];
  };
  console.log('A SEES', JSON.stringify(await seenBy(pageA)), 'B SEES', JSON.stringify(await seenBy(pageB)));

  // The page point each browser reports is the OTHER's screen position, converted by
  // tldraw: each matches the peer's move, not its own.
  await expect
    .poll(async () => ((await pageB.evaluate(readCollaborators)) as Collaborator[])[0]?.cursor?.x, { timeout: 15_000 })
    .toBeCloseTo(300, -1);
  await expect
    .poll(async () => ((await pageA.evaluate(readCollaborators)) as Collaborator[])[0]?.cursor?.x, { timeout: 15_000 })
    .toBeCloseTo(600, -1);

  // 2) The face-pile: tldraw's PeopleMenu, rendered from the same records.
  await expect(pageA.locator('.tlui-people-menu__avatar').first()).toBeVisible({ timeout: 15_000 });

  // 3) Follow mode. B zooms to a value A does not have, A follows B, and A's camera
  // lands on it — the follow is only observable because the zoom differs.
  await pageB.evaluate(() => (window as any).__canvasEditor.setCamera({ x: -500, y: -250, z: 2 }, { immediate: true }) && undefined);
  const followed = await pageA.evaluate(() => {
    const e = (window as any).__canvasEditor;
    e.startFollowingUser(e.getCollaborators()[0].userId);
    return e.getInstanceState().followingUserId;
  });
  expect(followed).toBeTruthy();
  await expect
    .poll(async () => await pageA.evaluate(() => (window as any).__canvasEditor.getCamera().z), { timeout: 15_000 })
    .toBeCloseTo(2, 1);
  console.log('A CAMERA AFTER FOLLOW', await pageA.evaluate(() => (window as any).__canvasEditor.getCamera()));

  await contextA.close();
  await contextB.close();
});
