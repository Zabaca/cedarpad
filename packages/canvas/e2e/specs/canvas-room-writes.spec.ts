/**
 * #305, the acceptance test for the bug that made `main` un-deployable: the browser read
 * from the Durable-Object-hosted room (#290) while the bridge still wrote to an in-memory
 * store nobody read, so a write 200'd and nothing appeared.
 *
 * Every hop is the real one — a real signed-in user, the real edge gate, the real bridge
 * process, the real room. The agent leg posts exactly the request `worker/mcp-tools.ts`
 * proxies; the UI leg issues exactly the fetch `ComponentPalette.tsx` issues, from inside
 * the page. The reload is what separates "broadcast" from "in the room".
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

const BRIDGE = `http://localhost:${process.env.CANVAS_BRIDGE_PORT}`;

test.use({ storageState: OWNER_STATE });

test('agent write + UI place appear in a watching browser and survive reload', async ({ page, owner, request }) => {
  // A real canvas in the bridge's workspace.
  const created = await owner.post('/api/canvases', { data: { name: `room-writes-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  // A browser watching that canvas, synced against the Durable Object (#290).
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // 1) The MCP agent write: exactly the request worker/mcp-tools.ts proxies to the bridge.
  const marker = `agent-wrote-${Date.now()}`;
  const wrote = await request.post(`${BRIDGE}/api/canvas/shapes/create`, {
    headers: { 'x-canvas-id': canvasId, 'content-type': 'application/json' },
    data: { shapes: [{ type: 'note', x: 100, y: 100, text: marker }] },
  });
  console.log('AGENT WRITE', wrote.status(), await wrote.text());
  expect(wrote.ok()).toBeTruthy();

  await expect(page.getByText(marker).first()).toBeAttached({ timeout: 20_000 });

  // 2) The UI place: the exact fetch ComponentPalette.tsx issues.
  const placed = await page.evaluate(async (cid) => {
    const r = await fetch('/api/components/place', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canvas-id': cid },
      body: JSON.stringify({ module: 'Counter', x: 400, y: 100, w: 220, h: 160 }),
    });
    return { status: r.status, body: await r.text() };
  }, canvasId);
  console.log('UI PLACE', placed.status, placed.body);
  expect(placed.status).toBe(200);

  // 3) Reload: it is in the room, not merely broadcast.
  await page.reload();
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await expect(page.getByText(marker).first()).toBeAttached({ timeout: 20_000 });

  // And the room itself agrees, read back through the edge as the user.
  const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
  const state = (await read.json()) as { version: number; shapes: Array<Record<string, unknown>> };
  console.log('ROOM', JSON.stringify(state.shapes.map((s) => ({ type: s.type, text: s.text, module: s.module }))));
  expect(state.shapes.some((s) => s.text === marker)).toBeTruthy();
  expect(state.shapes.some((s) => s.type === 'component' && s.module === 'Counter')).toBeTruthy();
});
