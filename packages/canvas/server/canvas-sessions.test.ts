// The bridge keys a CanvasStore per canvasId (ADR-0007: N canvases per workspace).
// createSessionRegistry is the pure keying core — a lazy map that builds a session on
// first access and returns the SAME one thereafter. Injecting a light factory (a bare
// CanvasStore, no I/O) lets us prove the two invariants the slice cares about: same
// canvasId → same store; distinct canvasIds → isolated stores.

import { describe, expect, test } from 'bun:test';

import { createSessionRegistry } from './canvas-sessions.ts';
import { createStore } from '../src/store.ts';
import type { CanvasShape } from '../src/shapes.ts';

const shape = (id: string): CanvasShape =>
  ({ id, type: 'geo', x: 0, y: 0, props: {} }) as unknown as CanvasShape;

// A factory that hands each canvasId its own store, counting builds so we can assert
// laziness / reuse. No persistence, no SSE — just the keyed store.
function storeRegistry() {
  const builds: string[] = [];
  const reg = createSessionRegistry(async (canvasId) => {
    builds.push(canvasId);
    return { canvasId, store: createStore() };
  });
  return { reg, builds };
}

describe('createSessionRegistry: per-canvas store keying', () => {
  test('same canvasId → same session (built once, reused)', async () => {
    const { reg, builds } = storeRegistry();
    const a1 = await reg.get('A');
    const a2 = await reg.get('A');
    expect(a1).toBe(a2);
    expect(a1.store).toBe(a2.store);
    expect(builds).toEqual(['A']); // lazy: built exactly once
  });

  test('distinct canvasIds → distinct sessions', async () => {
    const { reg, builds } = storeRegistry();
    const a = await reg.get('A');
    const b = await reg.get('B');
    expect(a.store).not.toBe(b.store);
    expect(builds).toEqual(['A', 'B']);
  });

  test('a mutation on canvas A does not affect canvas B (isolated stores)', async () => {
    const { reg } = storeRegistry();
    const a = await reg.get('A');
    const b = await reg.get('B');

    a.store.upsert([shape('s1')]);

    expect(a.store.getState().shapes.map((s) => s.id)).toEqual(['s1']);
    expect(b.store.getState().shapes).toEqual([]); // untouched
    expect(b.store.getState().version).toBe(0);
  });

  test('per-canvas getState reflects only that canvas\'s writes', async () => {
    const { reg } = storeRegistry();
    (await reg.get('A')).store.upsert([shape('a')]);
    (await reg.get('B')).store.upsert([shape('b1'), shape('b2')]);

    expect((await reg.get('A')).store.getState().shapes.map((s) => s.id)).toEqual(['a']);
    expect((await reg.get('B')).store.getState().shapes.map((s) => s.id)).toEqual(['b1', 'b2']);
  });

  test('close (delete) drops a session; the next get rebuilds a fresh one', async () => {
    const { reg, builds } = storeRegistry();
    const a1 = await reg.get('A');
    a1.store.upsert([shape('s1')]);
    expect(reg.has('A')).toBe(true);

    expect(reg.delete('A')).toBe(true);
    expect(reg.has('A')).toBe(false);

    const a2 = await reg.get('A'); // rebuilt from scratch
    expect(a2).not.toBe(a1);
    expect(a2.store.getState().shapes).toEqual([]);
    expect(builds).toEqual(['A', 'A']);
  });

  test('resolved() returns only sessions built so far (for flush-all fan-out)', async () => {
    const { reg } = storeRegistry();
    await reg.get('A');
    await reg.get('B');
    const resolved = await Promise.all(reg.resolved());
    expect(resolved.map((s) => s.canvasId).sort()).toEqual(['A', 'B']);
  });
});
