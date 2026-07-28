/**
 * #294, the acceptance test for the guest read path.
 *
 * A component-scoped share link (#221) is a capability to READ one canvas. This drives it
 * end to end with every hop real: a real member mints a real link, a real anonymous
 * browser walks through `/share/<id>`, and the pad it lands on renders the shared
 * component off a real WebSocket into the canvas's Durable-Object-hosted room — the same
 * room the member writes. Then the member edits, and the guest's page follows.
 *
 * The security half is asserted from INSIDE the guest's page, because that is the only
 * place with the guest's cookie: the room's own mutate door refuses it, and the room's
 * contents are read back as the member to prove nothing moved.
 *
 * The pad is selected by PATH — a `?canvas=` URL silently lands on `default`. Here the
 * guest never picks a path at all: the link's own canvas is what the pad opens.
 */
import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

const shapeId = () => `shape:${crypto.randomUUID()}`;

const component = (id: string, repo: string) => ({
  id,
  type: 'component' as const,
  x: 100,
  y: 100,
  w: 320,
  h: 200,
  color: 'black' as const,
  module: 'GithubRepoCard',
  data: { repo, url: `https://github.com/${repo}` },
  rev: 1,
});

test('a guest link renders the shared component and follows a member edit — and cannot write', async ({
  browser,
  owner,
}) => {
  const created = await owner.post('/api/canvases', { data: { name: `guest-read-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;

  // The member places the component that will be shared.
  const id = shapeId();
  const before = `zabaca/before-${Date.now()}`;
  const placed = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, {
    data: { op: 'upsert', shapes: [component(id, before)] },
  });
  expect(placed.ok()).toBeTruthy();

  // ...and mints a link scoped to THAT shape (#221).
  const minted = await owner.post(`/api/canvases/${canvasId}/share-links`, { data: { shapeId: id } });
  expect(minted.ok()).toBeTruthy();
  const linkId = ((await minted.json()) as { id: string }).id;

  // A genuinely anonymous browser: no member cookie, only what /share hands it.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`/share/${linkId}`);

  // The component-scoped surface: this ONE component, fullscreen. No tldraw canvas.
  await expect(guest.locator('.component-fullscreen-title')).toHaveText('GithubRepoCard', { timeout: 30_000 });
  await expect(guest.locator('.tl-canvas')).toHaveCount(0);
  await expect(guest.getByText(before)).toBeVisible({ timeout: 30_000 });

  // The member edits the shape in the room; the guest's page follows, live.
  const after = `zabaca/after-${Date.now()}`;
  const edited = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, {
    data: { op: 'upsert', shapes: [component(id, after)] },
  });
  expect(edited.ok()).toBeTruthy();
  await expect(guest.getByText(after)).toBeVisible({ timeout: 30_000 });

  // The guest cannot write. Asserted with the guest's OWN cookie, from their page:
  // the room's mutate door has no member session to authorize.
  const refused = await guest.evaluate(async (cid) => {
    const r = await fetch(`/api/canvas-sync/${cid}/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'clear' }),
    });
    return { status: r.status, body: await r.text() };
  }, canvasId);
  console.log('GUEST MUTATE', refused.status, refused.body);
  expect(refused.status).toBeGreaterThanOrEqual(400);

  // And the room still holds what the member last wrote — read back as the member.
  const read = await owner.post(`/api/canvas-sync/${canvasId}/mutate`, { data: { op: 'read' } });
  const state = (await read.json()) as { shapes: Array<Record<string, unknown>> };
  const shape = state.shapes.find((s) => s.id === id) as { data?: { repo?: string } } | undefined;
  expect(shape?.data?.repo).toBe(after);

  await guestContext.close();
});
