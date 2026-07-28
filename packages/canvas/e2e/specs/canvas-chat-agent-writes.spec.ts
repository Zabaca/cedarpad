/**
 * #310, the acceptance test: an IN-CANVAS CHAT AGENT draws, and a watching browser sees it.
 *
 * #305 closed this for the bridge's own HTTP handlers, but the chat turn kept the in-memory
 * session store — a store no browser has read since #290 — so an agent could report "drew it"
 * over an unchanged canvas. The turn now runs on a room-backed store settled after every tool
 * call (`server/turn-canvas-store.ts` + the settle wrapper in `server/agent.ts`).
 *
 * Every hop is the real one: the real bridge, the real turn pipeline, the real `create_shapes`
 * tool handler, the real Durable-Object-hosted room, a real signed-in browser. The single
 * stubbed thing is the Claude SDK's DECISION to call the tool (`E2E_MODE`, see
 * `e2eRunChat` in server/bridge.ts) — it needs a real OAuth token and a model round-trip.
 *
 * The two notes are drawn in two SEPARATE tool calls four seconds apart, which is what makes
 * the progressive claim testable: note "-a" must be visible while the turn is still running.
 *
 * Gotcha inherited from #305: the pad is selected by PATH, not `?canvas=` — a `?canvas=` URL
 * silently lands on `default`.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

const BRIDGE = `http://localhost:${process.env.CANVAS_BRIDGE_PORT}`;

test.use({ storageState: OWNER_STATE });

test('a chat agent draws into the room and a watching browser sees it appear mid-turn', async ({ page, owner, request }) => {
  const created = await owner.post('/api/canvases', { data: { name: `chat-agent-writes-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  // A browser watching that canvas, synced against the Durable Object (#290).
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Start a real chat turn on THAT canvas. `x-headless-send` is the subscriber-less send the
  // MCP surface uses (#177), so this spec needs no SSE client.
  const marker = `chat-agent-${Date.now()}`;
  const sent = await request.post(`${BRIDGE}/api/chat/e2e-${marker}/send`, {
    headers: { 'x-headless-send': '1', 'x-canvas-id': canvasId, 'content-type': 'application/json' },
    data: { message: `draw:${marker}` },
  });
  console.log('CHAT SEND', sent.status(), await sent.text());
  expect(sent.status()).toBe(202);

  // PROGRESSIVE: the first note must be visible while the turn is still drawing the second.
  await expect(page.getByText(`${marker}-a`).first()).toBeAttached({ timeout: 20_000 });
  await expect(page.getByText(`${marker}-b`)).toHaveCount(0);

  // ...and the second arrives on its own tool call.
  await expect(page.getByText(`${marker}-b`).first()).toBeAttached({ timeout: 20_000 });

  // Reload: it is in the room, not merely broadcast.
  await page.reload();
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  await expect(page.getByText(`${marker}-a`).first()).toBeAttached({ timeout: 20_000 });

  // And the room itself agrees, read back through the edge as the user.
  const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
  const state = (await read.json()) as { shapes: Array<Record<string, unknown>> };
  console.log('ROOM', JSON.stringify(state.shapes.map((s) => s.text)));
  expect(state.shapes.some((s) => s.text === `${marker}-a`)).toBeTruthy();
  expect(state.shapes.some((s) => s.text === `${marker}-b`)).toBeTruthy();
});
