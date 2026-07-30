/**
 * The gap that let 2026-07-30 reach production: nothing exercised a placed Component after the
 * container lost its filesystem.
 *
 * Every Record test is a unit test against a fake store, and every canvas e2e spec draws shapes
 * that need no source on disk. So on-demand materialization (ADR-0022 decision 5) — the thing
 * that replaced the boot restore, and the ONLY thing standing between a deploy and a canvas of
 * broken cards — had no end-to-end coverage at all. It shipped a hole: a Component that imports
 * a sibling MODULE materialized without it, because only data siblings were followed. Eleven
 * cards on one canvas came back "Failed to fetch dynamically imported module" after a deploy.
 *
 * The shape of this spec follows that failure exactly:
 *   - a KIT nothing places, so nothing ever fetches it directly — it can only arrive with its
 *     importer, which is what made the bug invisible;
 *   - a CARD that imports it and renders what it exports, so "the card rendered" cannot be true
 *     unless the whole import graph reached disk;
 *   - `rm -rf` of the canvas's materialized directory, which is what a fresh container IS.
 *
 * The delete is the honest simulation: a container comes back with the Records intact and the
 * filesystem empty. Doing it from the spec works because the local "container" is this machine.
 */
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../fixtures/test.ts';
import { OWNER_STATE } from '../fixtures/test.ts';

test.use({ storageState: OWNER_STATE });

/** Where the container renders a canvas's own-tier Records. Deleting it is a cold boot. */
const ownDir = (canvasId: string) => fileURLToPath(new URL(`../../src/canvas-${canvasId}/`, import.meta.url));

/**
 * Every canvas this spec materializes into, swept afterwards: these are real files in the
 * repo's `src/`, so leaving them behind puts test components in the next `tsc --noEmit`.
 *
 * `afterAll`, not `afterEach`, and the difference is not cosmetic. `afterEach` runs while the
 * page fixture is still open, and deleting these files makes vite broadcast a full reload —
 * which the live page answers by re-requesting the module, which materializes it straight back.
 * The sweep has to happen after the browser is gone.
 */
const materialized: string[] = [];
test.afterAll(() => {
  for (const dir of materialized.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a placed Component still renders after the container loses its filesystem', async ({ page, owner }) => {
  const created = await owner.post('/api/canvases', { data: { name: `cold-container-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  const canvasId = ((await created.json()) as { id: string }).id;
  materialized.push(ownDir(canvasId));
  const headers = { 'x-canvas-id': canvasId };

  // The label lives in the KIT, so it is on screen only if the kit reached disk too.
  const label = `kit-label-${Date.now()}`;

  const kit = await owner.put('/api/components/ColdKit', {
    headers,
    data: { source: `export const LABEL = ${JSON.stringify(label)};\n` },
  });
  expect(kit.ok(), 'writing the kit').toBeTruthy();

  const card = await owner.put('/api/components/ColdCard', {
    headers,
    data: {
      source: [
        "import { LABEL } from './ColdKit';",
        '',
        'export default function ColdCard() {',
        '  return <div data-testid="cold-card">{LABEL}</div>;',
        '}',
        '',
      ].join('\n'),
    },
  });
  expect(card.ok(), 'writing the card').toBeTruthy();

  const placed = await owner.post('/api/components/place', {
    headers,
    data: { module: 'ColdCard', x: 200, y: 200, w: 300, h: 200 },
  });
  expect(placed.ok(), 'placing the card').toBeTruthy();

  // Warm: the files the write just left behind are still there, so this proves only that the
  // card is placed and renders at all.
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await expect(page.getByTestId('cold-card')).toHaveText(label, { timeout: 30_000 });

  // Cold: the container comes back with nothing on disk. The Records are untouched — that is
  // the whole premise of ADR-0022, and the only reason this is recoverable rather than a loss.
  rmSync(ownDir(canvasId), { recursive: true, force: true });
  expect(existsSync(ownDir(canvasId)), 'the canvas dir is really gone').toBe(false);

  await page.reload();

  // Renders again — which requires BOTH Records to have been materialized on demand, the kit
  // only because the card imports it. Before the fix this was "Component error · ColdCard".
  await expect(page.getByTestId('cold-card')).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText('Component error')).toHaveCount(0);
});
