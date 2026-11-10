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

  test('B8 fsBackend lists the keys in a prefix dir off real disk, and nothing for an absent one', async () => {
    const root = join(tmpdir(), `Tmp_BlobStoreList_${process.pid}`);
    try {
      const backend = fsBackend(root);
      await backend.put('workspaces/ws1/a.json', new Uint8Array([1]));
      await backend.put('workspaces/ws2/b.json', new Uint8Array([1]));
      expect(await backend.list('workspaces/ws1/')).toEqual(['workspaces/ws1/a.json']);
      expect(await backend.list('workspaces/ws-absent/')).toEqual([]);
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
