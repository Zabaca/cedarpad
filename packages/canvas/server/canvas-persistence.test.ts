import { describe, expect, test } from 'bun:test';

import type { CanvasShape, CanvasState } from '../src/shapes.ts';
import { CanvasPersistence } from './canvas-persistence.ts';
import { type BlobBackend, BlobStore, memBackend } from './blob-store.ts';

const empty = (): CanvasState => ({ version: 1, shapes: [] });
const nonEmpty = (): CanvasState => ({
  version: 2,
  shapes: [{ id: 'a' } as unknown as CanvasShape],
});
// A canvas of N shapes, for the destructive-shrink guard tests.
const withShapes = (n: number, version = 2): CanvasState => ({
  version,
  shapes: Array.from({ length: n }, (_, i) => ({ id: `s${i}` }) as unknown as CanvasShape),
});

// A backend that throws on read and records every write, to prove the guard.
const trackingBroken = () => {
  const puts: string[] = [];
  const backend: BlobBackend = {
    get: () => {
      throw new Error('r2 read failed');
    },
    put: async (key) => void puts.push(key),
    exists: async () => false,
    list: async () => [],
  };
  return { backend, puts };
};

describe('CanvasPersistence data-loss guard', () => {
  test('C1 after a failed load, an empty-state save is refused', async () => {
    const { backend, puts } = trackingBroken();
    const p = new CanvasPersistence(new BlobStore(backend), 'ws1', 'c1');
    await expect(p.load()).rejects.toThrow(/r2 read failed/);
    await p.save(empty());
    expect(puts).toEqual([]); // known-good R2 data left untouched
  });

  test('C2 after a successful (even absent) load, an empty-state save is allowed', async () => {
    const store = new BlobStore(memBackend());
    const p = new CanvasPersistence(store, 'ws1', 'c1');
    expect(await p.load()).toBeNull(); // absent = legitimately empty, not degraded
    await p.save(empty());
    expect(await store.loadCanvasState('ws1', 'c1')).toEqual(empty());
  });

  test('C3 a non-empty save is always allowed, even while degraded', async () => {
    const { backend, puts } = trackingBroken();
    const p = new CanvasPersistence(new BlobStore(backend), 'ws1', 'c1');
    await expect(p.load()).rejects.toThrow();
    await p.save(nonEmpty());
    expect(puts).toEqual(['workspaces/ws1/canvases/c1/canvas-state.json']);
  });

  // Destructive-shrink guard: a substantial canvas must never be overwritten by a
  // near-empty one in a single save (the tldraw-crash nuke that wiped 364 shapes → 1).
  test('C4 a catastrophic shrink is refused and the on-disk good state is preserved', async () => {
    const store = new BlobStore(memBackend());
    const p = new CanvasPersistence(store, 'ws1', 'c1');
    expect(await p.save(withShapes(100))).toBe(true); // establishes the baseline
    expect(await p.save(withShapes(1))).toBe(false); // 100 → 1 = lost 99% → blocked
    expect(p.blockedShrink).toEqual({ from: 100, to: 1 });
    expect((await store.loadCanvasState('ws1', 'c1'))!.shapes.length).toBe(100); // disk untouched
  });

  test('C5 a moderate shrink (kept > 10%) is allowed', async () => {
    const store = new BlobStore(memBackend());
    const p = new CanvasPersistence(store, 'ws1', 'c1');
    await p.save(withShapes(100));
    expect(await p.save(withShapes(80))).toBe(true);
    expect(p.blockedShrink).toBeNull();
    expect((await store.loadCanvasState('ws1', 'c1'))!.shapes.length).toBe(80);
  });

  test('C6 a tiny canvas (below the floor) is not guarded — a real clear still persists', async () => {
    const store = new BlobStore(memBackend());
    const p = new CanvasPersistence(store, 'ws1', 'c1');
    await p.save(withShapes(5));
    expect(await p.save(withShapes(0))).toBe(true); // 5 < floor → not protected
    expect((await store.loadCanvasState('ws1', 'c1'))!.shapes.length).toBe(0);
  });

  test('C7 the baseline holds across repeated blocks (a multi-step crash stays measured against the good count)', async () => {
    const store = new BlobStore(memBackend());
    const p = new CanvasPersistence(store, 'ws1', 'c1');
    await p.save(withShapes(100));
    expect(await p.save(withShapes(1))).toBe(false); // blocked, baseline NOT lowered to 1
    expect(await p.save(withShapes(2))).toBe(false); // still measured against 100 → blocked
    expect((await store.loadCanvasState('ws1', 'c1'))!.shapes.length).toBe(100);
  });

  test('C8 the baseline is seeded from load(), so a shrink right after boot is caught', async () => {
    const store = new BlobStore(memBackend());
    await store.saveCanvasState('ws1', 'c1', withShapes(100));
    const p = new CanvasPersistence(store, 'ws1', 'c1');
    await p.load(); // seeds the baseline at 100 without any prior save this session
    expect(await p.save(withShapes(1))).toBe(false);
    expect((await store.loadCanvasState('ws1', 'c1'))!.shapes.length).toBe(100);
  });
});
