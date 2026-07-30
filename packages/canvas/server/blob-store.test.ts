import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanvasState } from '../src/shapes.ts';
import {
  type BlobBackend,
  BlobStore,
  canvasStateKey,
  fsBackend,
  memBackend,
} from './blob-store.ts';

const sampleState = (): CanvasState => ({ version: 3, shapes: [] });

const sampleSidecar = (name: string) => ({
  name,
  description: `The ${name} mart.`,
  columns: [{ name: 'id', type: 'VARCHAR' as const, description: 'The id.' }],
  generatedAt: '2026-07-27T09:01:05.107Z',
  rowCount: 3,
});

describe('blob keys', () => {
  test('B1 canvasStateKey', () => {
    expect(canvasStateKey('ws1', 'c1')).toEqual('workspaces/ws1/canvases/c1/canvas-state.json');
  });

  // #366: `sharedComponentsKey`, `canvasDirsKey` and `skillsKey` are gone. The archives they
  // named are frozen in the bucket as the pre-migration rollback, but nothing in the running
  // system may name them — the migration's read-only survey spells its own keys out
  // (`record-migration.ts`), the way #357 did when the custom-handler feature went.
  test('B2c the store offers no door to a workspace content archive', () => {
    const store = new BlobStore(memBackend()) as unknown as Record<string, unknown>;
    for (const door of [
      'loadSharedComponents',
      'saveSharedComponents',
      'loadCanvasDirs',
      'saveCanvasDirs',
      'loadSkills',
      'saveSkills',
      // The existence probe existed only so the empty-archive guard could ask "is there
      // something on the other side to destroy?" — there is no full-replace write left to ask.
      'blobExists',
    ]) {
      expect(store[door]).toBeUndefined();
    }
  });
});

describe('BlobStore', () => {
  // #297 deleted the WRITER — nothing persists canvas-state.json any more. The reader
  // stays because the retained blobs are what the cutover (#295) imports and what a
  // rollback re-imports, so it is exercised against bytes put through the backend.
  test('B3 a retained canvas-state blob still reads back', async () => {
    const backend = memBackend();
    const store = new BlobStore(backend);
    const state = sampleState();
    await backend.put(canvasStateKey('ws1', 'c1'), new TextEncoder().encode(JSON.stringify(state)));
    expect(await store.loadCanvasState('ws1', 'c1')).toEqual(state);
  });

  test('B4 absent canvas state loads as null (empty is not an error)', async () => {
    const store = new BlobStore(memBackend());
    expect(await store.loadCanvasState('ws1', 'nope')).toBeNull();
  });

  test('B5 a backend error on load propagates', async () => {
    const broken: BlobBackend = {
      get: () => {
        throw new Error('backend down');
      },
      put: async () => {},
      exists: async () => false,
      list: async () => [],
    };
    const store = new BlobStore(broken);
    expect(store.loadCanvasState('ws1', 'c1')).rejects.toThrow(/backend down/);
  });

  test('B8 listMarts returns every mart sidecar in the workspace, parsed', async () => {
    const store = new BlobStore(memBackend());
    await store.saveMartSidecar('ws1', 'mart_a', sampleSidecar('mart_a'));
    await store.saveMartSidecar('ws1', 'mart_b', sampleSidecar('mart_b'));
    // A different workspace's mart must not leak into ws1's listing.
    await store.saveMartSidecar('ws2', 'mart_other', sampleSidecar('mart_other'));
    // The parquet sits next to the sidecar under the same prefix; listing keys off the
    // sidecar, so this must not produce a phantom second entry.
    await store.saveMart('ws1', 'mart_a', new Uint8Array([1, 2, 3]));

    const marts = await store.listMarts('ws1');
    expect(marts.map((m) => m.name).sort()).toEqual(['mart_a', 'mart_b']);
    expect(marts[0]!.columns[0]!.description).toEqual('The id.');
  });

  test('B8b listMarts skips a malformed sidecar instead of failing the whole listing', async () => {
    const store = new BlobStore(memBackend());
    await store.saveMartSidecar('ws1', 'mart_good', sampleSidecar('mart_good'));
    await store.saveMartSidecar('ws1', 'mart_bad', { name: 'mart_bad', nope: true });

    expect((await store.listMarts('ws1')).map((m) => m.name)).toEqual(['mart_good']);
  });

  test('B8c listMarts is empty for a workspace with no warehouse', async () => {
    expect(await new BlobStore(memBackend()).listMarts('ws-empty')).toEqual([]);
  });

  test('B8d fsBackend lists marts off real disk', async () => {
    const root = join(tmpdir(), `Tmp_BlobStoreMarts_${process.pid}`);
    try {
      const store = new BlobStore(fsBackend(root));
      await store.saveMartSidecar('ws1', 'mart_disk', sampleSidecar('mart_disk'));
      await store.saveMart('ws1', 'mart_disk', new Uint8Array([1]));
      expect((await store.listMarts('ws1')).map((m) => m.name)).toEqual(['mart_disk']);
      expect(await store.listMarts('ws-absent')).toEqual([]);
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });

  test('B7 fsBackend reads canvas state back through nested key dirs', async () => {
    const root = join(tmpdir(), `Tmp_BlobStoreTest_${process.pid}`);
    try {
      const backend = fsBackend(root);
      const store = new BlobStore(backend);
      const state = sampleState();
      await backend.put(canvasStateKey('ws1', 'c1'), new TextEncoder().encode(JSON.stringify(state)));
      expect(await store.loadCanvasState('ws1', 'c1')).toEqual(state);
      expect(await store.loadCanvasState('ws1', 'absent')).toBeNull();
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
