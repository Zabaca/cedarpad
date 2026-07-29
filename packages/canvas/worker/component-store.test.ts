import { describe, expect, test } from 'bun:test';

import { componentStore } from './component-store.ts';
import { memRecordStore, type RecordStore } from './record-store.ts';

// The Component policy layer: what a Component write MEANS, independent of where the rows
// live. Driven against the in-memory Record port, so none of this needs a database.

describe('ComponentStore — an own-tier Component round-trips', () => {
  test('a written Component reads back with its source', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'KpiCard', source: 'export default () => null;', userId: 'u_1' });

    expect(await store.read({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'KpiCard' })).toBe('export default () => null;');
  });

  test('a Component this canvas never wrote reads back as null', async () => {
    const store = componentStore(memRecordStore());
    expect(await store.read({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Absent' })).toBeNull();
  });

  test('rewriting a Component keeps the earlier source in history', async () => {
    const records = memRecordStore();
    const store = componentStore(records);
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Card' };
    await store.write({ ...key, source: 'v1', userId: 'u_1' });
    const second = await store.write({ ...key, source: 'v2', userId: 'u_1' });

    expect(second.rev).toBe(2);
    expect((await records.listVersions(key)).map((v) => v.source)).toEqual(['v2', 'v1']);
  });
});

// History is only useful if it can be ASKED FOR. `listVersions` on the port is where the rows
// are; `history` is the answer to the question a workspace owner actually has — "who last
// changed this Component, and when" — which nothing in this product could answer before.
describe('ComponentStore — a Component can be asked for its history', () => {
  test('history lists every version newest first, each with its author and time', async () => {
    const store = componentStore(memRecordStore());
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Card' };
    await store.write({ ...key, source: 'v1', userId: 'u_1' });
    await store.write({ ...key, source: 'v2', userId: 'u_2' });

    const history = await store.history(key);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history.map((v) => v.createdBy)).toEqual(['u_2', 'u_1']);
    expect(history.every((v) => v.createdAt instanceof Date)).toBe(true);
  });

  test('a Component nobody ever wrote has an empty history, not an error', async () => {
    const store = componentStore(memRecordStore());
    expect(await store.history({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Absent' })).toEqual([]);
  });

  test('a deleted Component still has its history — a deletion must not destroy the record of it', async () => {
    // The whole promise of soft delete (ADR-0022 decision 9): deleting a canvas hides its
    // own tier, and the thing that makes that safe is that the history is still there to
    // restore from. A `history` that answered through the live row would break it silently.
    const records = memRecordStore();
    const store = componentStore(records);
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Card' };
    await store.write({ ...key, source: 'v1', userId: 'u_1' });
    await records.softDelete(key);

    expect(await store.read(key)).toBeNull();
    expect((await store.history(key)).map((v) => v.version)).toEqual([1]);
  });

  test('history refuses a traversing name for the same reason a write does', async () => {
    const store = componentStore(memRecordStore());
    await expect(store.history({ workspaceId: 'ws_a', canvasId: 'cv_1', name: '../../etc/passwd' })).rejects.toThrow(
      /invalid component name/,
    );
  });
});

describe('ComponentStore — the three tiers, and moving between them', () => {
  const WS = 'ws_a';
  const CV = 'cv_1';
  const own = (name: string) => ({ workspaceId: WS, canvasId: CV, name });
  const shared = (name: string) => ({ workspaceId: WS, canvasId: null, name });

  test('a shared Component is visible to every canvas in the workspace', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ ...shared('Legend'), source: 'shared source', userId: 'u_1' });

    expect(await store.read(shared('Legend'))).toBe('shared source');
    // Two different canvases, one library: neither owns it, both can resolve it.
    expect(await store.read(own('Legend'))).toBeNull();
    expect(await store.read({ workspaceId: WS, canvasId: 'cv_2', name: 'Legend' })).toBeNull();
  });

  test('a canvas owning the same name shadows the shared Component rather than overwriting it', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ ...shared('Legend'), source: 'shared source', userId: 'u_1' });
    await store.write({ ...own('Legend'), source: 'my source', userId: 'u_1' });

    expect(await store.read(own('Legend'))).toBe('my source');
    expect(await store.read(shared('Legend'))).toBe('shared source');
  });

  test('promote moves the Component to the shared library and leaves no own-tier copy', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ ...own('Legend'), source: 'v1', userId: 'u_1' });

    const { rev } = await store.promote({ workspaceId: WS, canvasId: CV, name: 'Legend', userId: 'u_2' });

    expect(rev).toBe(2); // derived from the store's confirmed write, not from having tried
    expect(await store.read(shared('Legend'))).toBe('v1');
    expect(await store.read(own('Legend'))).toBeNull();
  });

  test('promote appends a version, attributed to whoever promoted it', async () => {
    const records = memRecordStore();
    const store = componentStore(records);
    await store.write({ ...own('Legend'), source: 'v1', userId: 'u_1' });
    await store.promote({ workspaceId: WS, canvasId: CV, name: 'Legend', userId: 'u_2' });

    expect((await records.listVersions(shared('Legend'))).map((v) => [v.version, v.createdBy])).toEqual([
      [2, 'u_2'],
      [1, 'u_1'],
    ]);
  });

  test('promote refuses a Component this canvas does not own', async () => {
    const store = componentStore(memRecordStore());
    await expect(store.promote({ workspaceId: WS, canvasId: CV, name: 'Ghost', userId: null })).rejects.toThrow(/not in canvas/);
  });

  test('promote refuses a name the shared library already holds', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ ...shared('Legend'), source: 'theirs', userId: 'u_1' });
    await store.write({ ...own('Legend'), source: 'mine', userId: 'u_1' });

    await expect(store.promote({ workspaceId: WS, canvasId: CV, name: 'Legend', userId: null })).rejects.toThrow(/already exists/);
    expect(await store.read(shared('Legend'))).toBe('theirs');
  });

  // The reported incident, as a test. `promote_component` reported success while the shared
  // write never landed — and because promote REMOVES the own copy, resolution fell through to
  // the read-only platform tier, where a same-named component rendered with the wrong props.
  // A missing card is visible; a wrong card is not. So: never give up tier 1 until tier 2 is
  // durable, and never report success from having attempted a write.
  test('when the store refuses the move, the Component is still in the canvas that owns it', async () => {
    const records = memRecordStore();
    const failing: RecordStore = { ...records, move: async () => { throw new Error('the workspace store refused this write'); } };
    const store = componentStore(failing);
    await store.write({ ...own('MarkdownCard'), source: 'my markdown card', userId: 'u_1' });

    await expect(store.promote({ workspaceId: WS, canvasId: CV, name: 'MarkdownCard', userId: null })).rejects.toThrow(/refused/);
    expect(await store.read(own('MarkdownCard'))).toBe('my markdown card');
    expect(await store.read(shared('MarkdownCard'))).toBeNull();
  });

  test('adopt copies the shared Component into the canvas and leaves the shared one intact', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ ...shared('Legend'), source: 'shared source', userId: 'u_1' });

    const { rev } = await store.adopt({ workspaceId: WS, canvasId: CV, name: 'Legend', userId: 'u_2' });

    expect(rev).toBe(1);
    expect(await store.read(own('Legend'))).toBe('shared source');
    expect(await store.read(shared('Legend'))).toBe('shared source');
  });

  test('adopting then editing diverges this canvas without touching the shared source', async () => {
    const store = componentStore(memRecordStore());
    await store.write({ ...shared('Legend'), source: 'shared source', userId: 'u_1' });
    await store.adopt({ workspaceId: WS, canvasId: CV, name: 'Legend', userId: 'u_1' });
    await store.write({ ...own('Legend'), source: 'diverged', userId: 'u_1' });

    expect(await store.read(own('Legend'))).toBe('diverged');
    expect(await store.read(shared('Legend'))).toBe('shared source');
  });

  test('adopt refuses a Component the shared library does not hold', async () => {
    const store = componentStore(memRecordStore());
    await expect(store.adopt({ workspaceId: WS, canvasId: CV, name: 'Ghost', userId: null })).rejects.toThrow(/no shared component/);
  });
});

describe('ComponentStore — the edge validates, it does not trust the caller', () => {
  // The container names the Component; the edge decides whether that name is a Component
  // at all. A traversing name is how a "write" becomes a write to somewhere else.
  test.each([['../../etc/passwd'], ['a/b'], ['Card.tsx'], [''], ['1Card']])('rejects the name %p', async (name) => {
    const store = componentStore(memRecordStore());
    await expect(store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name, source: 'x', userId: null })).rejects.toThrow(/invalid component name/);
  });

  test('rejects an empty source rather than storing a blank Component', async () => {
    const store = componentStore(memRecordStore());
    await expect(
      store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Card', source: '   \n', userId: null }),
    ).rejects.toThrow(/non-empty/);
  });

  test('a rejected write stores nothing', async () => {
    const records = memRecordStore();
    const store = componentStore(records);
    await expect(store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Card', source: '', userId: null })).rejects.toThrow();
    expect(await records.get({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'Card' })).toBeNull();
  });
});
