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
  sessionsKey,
  skillsKey,
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

  test('B2b sessionsKey', () => {
    expect(sessionsKey('ws1')).toEqual('workspaces/ws1/sessions.tar');
  });

  test('B2c skillsKey', () => {
    expect(skillsKey('ws1')).toEqual('workspaces/ws1/skills.tar');
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
      list: async () => [],
    };
    const store = new BlobStore(broken);
    expect(store.loadCanvasState('ws1', 'c1')).rejects.toThrow(/backend down/);
  });

  test('B6b session bytes round-trip', async () => {
    const store = new BlobStore(memBackend());
    const bytes = new Uint8Array([9, 8, 7, 0]);
    await store.saveSessions('ws1', bytes);
    expect(await store.loadSessions('ws1')).toEqual(bytes);
  });

  test('B6c workspace-skill bytes round-trip (ADR-0013)', async () => {
    const store = new BlobStore(memBackend());
    const bytes = new Uint8Array([4, 2, 0, 128]);
    await store.saveSkills('ws1', bytes);
    expect(await store.loadSkills('ws1')).toEqual(bytes);
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
