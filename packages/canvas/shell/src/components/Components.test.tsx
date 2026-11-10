// Register happy-dom's window/document BEFORE importing the component tree.
import '../../../src/happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentsStage, instanceSummary, tierCounts } from './Components';

const INVENTORY = {
  components: [
    {
      name: 'Roadmap',
      tier: 'own',
      canvasId: 'cv_a',
      instances: [
        { canvasId: 'cv_a', canvasName: 'Board A', shapeId: 'shape:a1' },
        { canvasId: 'cv_a', canvasName: 'Board A', shapeId: 'shape:a2', page: 'page:two' },
      ],
    },
    { name: 'KpiCard', tier: 'base', canvasId: null, instances: [] },
    { name: 'Ledger', tier: 'shared', canvasId: null, instances: [{ canvasId: 'cv_b', canvasName: 'Board B', shapeId: 'shape:b2' }] },
    { name: 'Ghost', tier: 'unresolved', canvasId: null, instances: [{ canvasId: 'cv_b', canvasName: 'Board B', shapeId: 'shape:b1' }] },
  ],
};

const realFetch = globalThis.fetch;
const realConfirm = globalThis.confirm;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  globalThis.fetch = realFetch;
  globalThis.confirm = realConfirm;
});

function stub(deletes: Array<{ method: string; body: unknown }>, inventory: unknown = INVENTORY) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/workspace-components')) {
      if (init?.method === 'DELETE') {
        deletes.push({ method: 'DELETE', body: JSON.parse(String(init.body)) });
        return Response.json({ instancesRemoved: 2, sourceDeleted: true });
      }
      return Response.json(inventory);
    }
    return Response.json({});
  }) as typeof fetch;
}

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(<ComponentsStage workspaceId="ws_1" />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return el;
}

const rowText = (el: HTMLElement) => [...el.querySelectorAll('.cmp-row')].map((r) => r.textContent ?? '');

describe('ComponentsStage', () => {
  test('lists the workspace library — built-in and shared only, with its tier and instance count', async () => {
    stub([]);
    const el = await mount();
    const rows = rowText(el);
    // The base tier is listed because it is placeable — it just is not deletable.
    expect(rows.some((t) => t.includes('KpiCard'))).toBe(true);
    expect(rows.some((t) => t.includes('Ledger') && t.includes('1'))).toBe(true);
    // A canvas-scoped Component belongs to its canvas, not to the workspace library.
    expect(rows.some((t) => t.includes('Roadmap'))).toBe(false);
    // A name with no source behind it is not a Component this stage can show a source for.
    expect(rows.some((t) => t.includes('Ghost'))).toBe(false);
  });

  test('a built-in Component offers no delete at all', async () => {
    stub([]);
    const el = await mount();
    const base = [...el.querySelectorAll('.cmp-row')].find((r) => (r.textContent ?? '').includes('KpiCard'))!;
    expect(base.querySelector('.cmp-delete')).toBeNull();
  });

  test('deleting names the exact Component, not just its name', async () => {
    const deletes: Array<{ method: string; body: unknown }> = [];
    stub(deletes);
    globalThis.confirm = () => true;
    const el = await mount();
    const row = [...el.querySelectorAll('.cmp-row')].find((r) => (r.textContent ?? '').includes('Ledger'))!;
    await act(async () => {
      (row.querySelector('.cmp-delete') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Tier + canvas travel with the name: a workspace can hold several Components called
    // `Ledger`, and the server resolves instances per canvas from exactly these three fields.
    expect(deletes).toEqual([{ method: 'DELETE', body: { name: 'Ledger', tier: 'shared', canvasId: null } }]);
  });

  test('declining the confirmation deletes nothing', async () => {
    const deletes: Array<{ method: string; body: unknown }> = [];
    stub(deletes);
    globalThis.confirm = () => false;
    const el = await mount();
    const row = [...el.querySelectorAll('.cmp-row')].find((r) => (r.textContent ?? '').includes('Ledger'))!;
    await act(async () => {
      (row.querySelector('.cmp-delete') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(deletes).toEqual([]);
  });
});

describe('ComponentsStage tier filter', () => {
  const chip = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('.cmp-filter')].find((b) => (b.textContent ?? '').includes(label)) as HTMLButtonElement;

  test('filtering to built-in narrows the list to the platform tier', async () => {
    stub([]);
    const el = await mount();
    await act(async () => chip(el, 'built-in').click());
    const rows = rowText(el);
    expect(rows.some((t) => t.includes('KpiCard'))).toBe(true);
    expect(rows.some((t) => t.includes('Ledger'))).toBe(false);
  });

  test('clicking the active chip clears the filter', async () => {
    stub([]);
    const el = await mount();
    await act(async () => chip(el, 'built-in').click());
    expect(rowText(el).some((t) => t.includes('Ledger'))).toBe(false);
    await act(async () => chip(el, 'built-in').click());
    expect(rowText(el).some((t) => t.includes('Ledger'))).toBe(true);
  });

  test('a tier with no Components gets no chip, so no filter can empty the list', async () => {
    // A workspace that has never shared a Component: only the built-in tier has rows.
    stub([], { components: [{ name: 'KpiCard', tier: 'base', canvasId: null, instances: [] }] });
    const el = await mount();
    const labels = [...el.querySelectorAll('.cmp-filter')].map((b) => b.textContent ?? '');
    expect(labels.some((t) => t.includes('shared'))).toBe(false);
    expect(labels.some((t) => t.includes('built-in'))).toBe(true);
  });

  test('the excluded tiers are offered no chip and are not counted in All', async () => {
    stub([]);
    const el = await mount();
    const labels = [...el.querySelectorAll('.cmp-filter')].map((b) => b.textContent ?? '');
    expect(labels.some((t) => t.includes('canvas'))).toBe(false);
    expect(labels.some((t) => t.includes('no source'))).toBe(false);
    // Two of the fixture's four Components are listed: KpiCard (built-in) and Ledger (shared).
    expect(labels.find((t) => t.includes('All'))).toBe('All 2');
  });
});

describe('tierCounts', () => {
  test('counts every tier, including the ones with nothing in them', () => {
    expect(tierCounts([{ tier: 'base' }, { tier: 'base' }, { tier: 'own' }])).toEqual({
      own: 1,
      shared: 0,
      base: 2,
      unresolved: 0,
    });
  });
});

describe('instanceSummary', () => {
  test('counts cards per canvas, so the confirmation says what is about to go', () => {
    expect(
      instanceSummary([
        { canvasId: 'cv_a', canvasName: 'Board A', shapeId: 's1' },
        { canvasId: 'cv_b', canvasName: 'Board B', shapeId: 's2' },
        { canvasId: 'cv_a', canvasName: 'Board A', shapeId: 's3' },
      ]),
    ).toEqual([
      { canvasName: 'Board A', count: 2 },
      { canvasName: 'Board B', count: 1 },
    ]);
  });

  test('no instances summarises to nothing rather than an empty-looking row', () => {
    expect(instanceSummary([])).toEqual([]);
  });
});
