import { describe, expect, test } from 'bun:test';

import { componentStore } from './component-store.ts';
import { memRecordStore } from './record-store.ts';

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
