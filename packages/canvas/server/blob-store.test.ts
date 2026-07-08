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
  componentsKey,
  memBackend,
  sessionsKey,
} from './blob-store.ts';

const sampleState = (): CanvasState => ({ version: 3, shapes: [] });

describe('blob keys', () => {
  test('B1 canvasStateKey', () => {
    expect(canvasStateKey('ws1', 'c1')).toEqual('workspaces/ws1/canvases/c1/canvas-state.json');
  });

  test('B2 componentsKey', () => {
    expect(componentsKey('ws1')).toEqual('workspaces/ws1/components.tar');
  });

  test('B2b sessionsKey', () => {
    expect(sessionsKey('ws1')).toEqual('workspaces/ws1/sessions.tar');
  });
});

describe('BlobStore', () => {
  test('B3 canvas state round-trips', async () => {
    const store = new BlobStore(memBackend());
    const state = sampleState();
    await store.saveCanvasState('ws1', 'c1', state);
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
    };
    const store = new BlobStore(broken);
    expect(store.loadCanvasState('ws1', 'c1')).rejects.toThrow(/backend down/);
  });

  test('B6 component-library bytes round-trip', async () => {
    const store = new BlobStore(memBackend());
    const bytes = new Uint8Array([1, 2, 3, 255]);
    await store.saveComponents('ws1', bytes);
    expect(await store.loadComponents('ws1')).toEqual(bytes);
  });

  test('B6b session bytes round-trip', async () => {
    const store = new BlobStore(memBackend());
    const bytes = new Uint8Array([9, 8, 7, 0]);
    await store.saveSessions('ws1', bytes);
    expect(await store.loadSessions('ws1')).toEqual(bytes);
  });

  test('B7 fsBackend round-trips canvas state through nested key dirs', async () => {
    const root = join(tmpdir(), `Tmp_BlobStoreTest_${process.pid}`);
    try {
      const store = new BlobStore(fsBackend(root));
      const state = sampleState();
      await store.saveCanvasState('ws1', 'c1', state);
      expect(await store.loadCanvasState('ws1', 'c1')).toEqual(state);
      expect(await store.loadCanvasState('ws1', 'absent')).toBeNull();
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
