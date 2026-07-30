// Register happy-dom's window/document BEFORE importing the component tree.
import '../../../src/happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentsStage, instanceSummary } from './Components';

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

function stub(deletes: Array<{ method: string; body: unknown }>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/workspace-components')) {
      if (init?.method === 'DELETE') {
        deletes.push({ method: 'DELETE', body: JSON.parse(String(init.body)) });
        return Response.json({ instancesRemoved: 2, sourceDeleted: true });
      }
      return Response.json(INVENTORY);
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
  test('lists every Component in the workspace with its tier and instance count', async () => {
    stub([]);
    const el = await mount();
    const rows = rowText(el);
    expect(rows.some((t) => t.includes('Roadmap') && t.includes('2'))).toBe(true);
    // The base tier is listed because it is placeable — it just is not deletable.
    expect(rows.some((t) => t.includes('KpiCard'))).toBe(true);
    // Dead cards are the other half of a cleanup, so they are visible rather than hidden.
    expect(rows.some((t) => t.includes('Ghost'))).toBe(true);
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
    const row = [...el.querySelectorAll('.cmp-row')].find((r) => (r.textContent ?? '').includes('Roadmap'))!;
    await act(async () => {
      (row.querySelector('.cmp-delete') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Tier + canvas travel with the name: a workspace can hold several Components called
    // `Roadmap`, and the server resolves instances per canvas from exactly these three.
    expect(deletes).toEqual([{ method: 'DELETE', body: { name: 'Roadmap', tier: 'own', canvasId: 'cv_a' } }]);
  });

  test('declining the confirmation deletes nothing', async () => {
    const deletes: Array<{ method: string; body: unknown }> = [];
    stub(deletes);
    globalThis.confirm = () => false;
    const el = await mount();
    const row = [...el.querySelectorAll('.cmp-row')].find((r) => (r.textContent ?? '').includes('Roadmap'))!;
    await act(async () => {
      (row.querySelector('.cmp-delete') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(deletes).toEqual([]);
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
