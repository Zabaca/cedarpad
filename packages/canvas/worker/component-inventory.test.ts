import { describe, expect, test } from 'bun:test';

import type { CanvasShape } from '../src/shapes.ts';
import { componentInventory, deleteComponent } from './component-inventory.ts';
import { memRecordStore } from './record-store.ts';

const WS = 'ws_1';
const card = (id: string, module: string, page?: string): CanvasShape => ({
  id,
  type: 'component',
  module,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  color: 'black',
  data: {},
  rev: 1,
  ...(page ? { page } : {}),
});

/** An inventory over a fixed set of canvases and their component cards. */
async function inventory(opts: {
  own?: Array<{ canvasId: string; name: string }>;
  shared?: string[];
  base?: string[];
  canvases: Array<{ id: string; name: string; shapes: CanvasShape[] }>;
}) {
  const records = memRecordStore();
  for (const o of opts.own ?? []) {
    await records.put({ workspaceId: WS, canvasId: o.canvasId, name: o.name, kind: 'component', source: `// ${o.name}`, updatedBy: null });
  }
  for (const name of opts.shared ?? []) {
    await records.put({ workspaceId: WS, canvasId: null, name, kind: 'component', source: `// ${name}`, updatedBy: null });
  }
  return componentInventory({
    records,
    workspaceId: WS,
    canvases: opts.canvases.map((c) => ({ id: c.id, name: c.name })),
    readShapes: async (canvasId) => opts.canvases.find((c) => c.id === canvasId)?.shapes ?? [],
    base: (opts.base ?? []).map((name) => ({ name, description: '' })),
  });
}

describe('componentInventory', () => {
  test('lists every Component in the workspace across tiers, with where it lives', async () => {
    const entries = await inventory({
      own: [{ canvasId: 'cv_a', name: 'Kanban' }],
      shared: ['Roadmap'],
      base: ['KpiCard'],
      canvases: [{ id: 'cv_a', name: 'Board A', shapes: [] }],
    });
    expect(entries.map((e) => [e.name, e.tier, e.canvasId])).toEqual([
      ['Kanban', 'own', 'cv_a'],
      ['KpiCard', 'base', null],
      ['Roadmap', 'shared', null],
    ]);
  });

  test('an instance is attributed to the Component its OWN canvas resolves, not to every same-named one', async () => {
    // The trap this module exists to avoid. Canvas A shadows the shared `Roadmap` with its
    // own; canvas B has no own copy and so resolves the shared one. Matching instances on
    // module name alone would attribute both cards to both Components — and a delete built
    // on that would take A's card down when the SHARED Component was deleted.
    const entries = await inventory({
      own: [{ canvasId: 'cv_a', name: 'Roadmap' }],
      shared: ['Roadmap'],
      canvases: [
        { id: 'cv_a', name: 'Board A', shapes: [card('shape:a1', 'Roadmap')] },
        { id: 'cv_b', name: 'Board B', shapes: [card('shape:b1', 'Roadmap')] },
      ],
    });
    const own = entries.find((e) => e.tier === 'own')!;
    const shared = entries.find((e) => e.tier === 'shared')!;
    expect(own.instances.map((i) => i.shapeId)).toEqual(['shape:a1']);
    expect(shared.instances.map((i) => i.shapeId)).toEqual(['shape:b1']);
  });

  test('instances carry the canvas name and page, so a delete can be confirmed before it fires', async () => {
    const entries = await inventory({
      shared: ['Roadmap'],
      canvases: [{ id: 'cv_a', name: 'Board A', shapes: [card('shape:a1', 'Roadmap', 'page:two')] }],
    });
    expect(entries[0]?.instances).toEqual([
      { canvasId: 'cv_a', canvasName: 'Board A', shapeId: 'shape:a1', page: 'page:two' },
    ]);
  });

  test('a card whose Component is gone is reported as unresolved, not silently dropped', async () => {
    // These are the dead cards — a card rendering nothing, on a canvas whose source was
    // deleted or lost. They are the other half of "clean this up", and a listing that
    // omitted them would make the canvas look tidier than it is.
    const entries = await inventory({
      canvases: [{ id: 'cv_a', name: 'Board A', shapes: [card('shape:a1', 'Ghost')] }],
    });
    expect(entries).toEqual([
      {
        name: 'Ghost',
        tier: 'unresolved',
        canvasId: null,
        instances: [{ canvasId: 'cv_a', canvasName: 'Board A', shapeId: 'shape:a1' }],
      },
    ]);
  });

  test('a Component with no instances is still listed — that is what makes it deletable', async () => {
    const entries = await inventory({
      own: [{ canvasId: 'cv_a', name: 'Unused' }],
      canvases: [{ id: 'cv_a', name: 'Board A', shapes: [] }],
    });
    expect(entries[0]).toMatchObject({ name: 'Unused', instances: [] });
  });
});

describe('deleteComponent', () => {
  /** Records + canvases + a recorder for what each room was asked to remove. */
  async function harness() {
    const records = memRecordStore();
    await records.put({ workspaceId: WS, canvasId: 'cv_a', name: 'Roadmap', kind: 'component', source: '// own', updatedBy: null });
    await records.put({ workspaceId: WS, canvasId: null, name: 'Roadmap', kind: 'component', source: '// shared', updatedBy: null });
    const shapes: Record<string, CanvasShape[]> = {
      cv_a: [card('shape:a1', 'Roadmap')],
      cv_b: [card('shape:b1', 'Roadmap'), card('shape:b2', 'Roadmap')],
    };
    const removed: Array<{ canvasId: string; ids: string[] }> = [];
    const deps = {
      records,
      workspaceId: WS,
      canvases: [
        { id: 'cv_a', name: 'Board A' },
        { id: 'cv_b', name: 'Board B' },
      ],
      readShapes: async (canvasId: string) => shapes[canvasId] ?? [],
      base: [] as Array<{ name: string; description: string }>,
      removeShapes: async (canvasId: string, ids: string[]) => {
        removed.push({ canvasId, ids });
      },
    };
    return { records, deps, removed };
  }

  test('deleting the shared Component removes only the cards that RESOLVED to it', async () => {
    const { records, deps, removed } = await harness();
    const result = await deleteComponent(deps, { name: 'Roadmap', tier: 'shared', canvasId: null });

    // Board A shadows it with its own copy, so A's card belongs to a different Component
    // and must survive. Deleting by name would have taken it.
    expect(removed).toEqual([{ canvasId: 'cv_b', ids: ['shape:b1', 'shape:b2'] }]);
    expect(result.instancesRemoved).toBe(2);
    expect(await records.get({ workspaceId: WS, canvasId: null, name: 'Roadmap' })).toBeNull();
    // ...and the own-tier Record is untouched.
    expect(await records.get({ workspaceId: WS, canvasId: 'cv_a', name: 'Roadmap' })).not.toBeNull();
  });

  test('the source is SOFT-deleted, so a mistaken cleanup is recoverable', async () => {
    const { records, deps } = await harness();
    await deleteComponent(deps, { name: 'Roadmap', tier: 'own', canvasId: 'cv_a' });
    expect(await records.get({ workspaceId: WS, canvasId: 'cv_a', name: 'Roadmap' })).toBeNull();
    // The versions survive the soft delete — this is the difference between a cleanup and
    // the 2026-07-29 loss (ADR-0022).
    expect((await records.listVersions({ workspaceId: WS, canvasId: 'cv_a', name: 'Roadmap' })).length).toBeGreaterThan(0);
  });

  test('a base Component is refused — it is code in the image, not a workspace Record', async () => {
    const { deps, removed } = await harness();
    await expect(deleteComponent(deps, { name: 'KpiCard', tier: 'base', canvasId: null })).rejects.toThrow(/built-in/i);
    expect(removed).toEqual([]);
  });

  test('unresolved cards can be swept even though there is no Record to delete', async () => {
    const records = memRecordStore();
    const removed: Array<{ canvasId: string; ids: string[] }> = [];
    await deleteComponent(
      {
        records,
        workspaceId: WS,
        canvases: [{ id: 'cv_a', name: 'Board A' }],
        readShapes: async () => [card('shape:a1', 'Ghost')],
        base: [],
        removeShapes: async (canvasId, ids) => {
          removed.push({ canvasId, ids });
        },
      },
      { name: 'Ghost', tier: 'unresolved', canvasId: null },
    );
    expect(removed).toEqual([{ canvasId: 'cv_a', ids: ['shape:a1'] }]);
  });
});
