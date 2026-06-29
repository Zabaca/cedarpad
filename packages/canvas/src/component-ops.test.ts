import { describe, expect, test } from 'bun:test';

import { bumpAllComponents, nextComponentRev, placeComponentOp, setComponentDataOp } from './canvas-ops';
import { createStore } from './store';

describe('placeComponentOp', () => {
  test('places a component instance referencing a module + data', () => {
    const store = createStore();
    const r = placeComponentOp(store, { module: 'KpiCard', x: 10, y: 20, data: { label: 'Rev', value: '$1M' }, rev: 1 });
    expect(r.isError).toBeUndefined();
    const s = store.getState().shapes[0]!;
    expect(s.type).toBe('component');
    if (s.type === 'component') {
      expect(s).toMatchObject({ module: 'KpiCard', x: 10, y: 20, w: 360, h: 260, rev: 1, data: { label: 'Rev', value: '$1M' } });
    }
  });

  test('rejects an invalid module name without mutating', () => {
    const store = createStore();
    const r = placeComponentOp(store, { module: '../evil', x: 0, y: 0, rev: 1 });
    expect(r.isError).toBe(true);
    expect(store.getState().shapes).toHaveLength(0);
  });

  test('chat-origin: HONORS the agent coords (no auto-tuck override) and adds a link arrow', () => {
    const store = createStore();
    store.upsert([{ id: 'shape:chatA', type: 'chat', color: 'black', x: 89, y: 56, w: 562, h: 654, title: 'Chat A' }]);
    placeComponentOp(store, { module: 'CloneLanding1', x: 700, y: 680, w: 340, h: 560, rev: 1 }, 'shape:chatA');
    const comp = store.getState().shapes.find((s) => s.type === 'component');
    // The agent's deliberate layout coords survive (the bug was these being flung to y~3700).
    expect(comp?.type === 'component' && comp.x).toBe(700);
    expect(comp?.type === 'component' && comp.y).toBe(680);
    const arrow = store.getState().shapes.find((s) => s.type === 'arrow');
    expect(arrow?.type === 'arrow' && arrow.startShapeId).toBe('shape:chatA');
    expect(arrow?.type === 'arrow' && arrow.endShapeId).toBe(comp?.id);
  });

  test('chat-origin with NO coords (0,0) falls back to auto-tuck beside the chat', () => {
    const store = createStore();
    store.upsert([{ id: 'shape:chatA', type: 'chat', color: 'black', x: 1000, y: 200, w: 380, h: 460, title: 'Chat A' }]);
    placeComponentOp(store, { module: 'KpiCard', x: 0, y: 0, w: 360, h: 260, rev: 1 }, 'shape:chatA');
    const comp = store.getState().shapes.find((s) => s.type === 'component');
    // Auto-tucked just left of the chat (1000 - 60 - 360 = 580), not left at the origin.
    expect(comp?.type === 'component' && comp.x).toBe(580);
    expect(comp?.type === 'component' && comp.y).toBe(200);
  });

  test('updates by id (retarget module + data) without adding a shape', () => {
    const store = createStore();
    placeComponentOp(store, { module: 'KpiCard', x: 0, y: 0, rev: 1 });
    const id = store.getState().shapes[0]!.id;
    placeComponentOp(store, { id, module: 'Dashboard', x: 0, y: 0, data: { title: 'X' }, rev: 2 });
    const shapes = store.getState().shapes;
    expect(shapes).toHaveLength(1);
    if (shapes[0]!.type === 'component') expect(shapes[0]!.module).toBe('Dashboard');
  });
});

describe('setComponentDataOp', () => {
  test('replaces data, leaving module/box intact', () => {
    const store = createStore();
    placeComponentOp(store, { module: 'KpiCard', x: 5, y: 5, data: { label: 'a' }, rev: 1 });
    const id = store.getState().shapes[0]!.id;
    const r = setComponentDataOp(store, id, { label: 'b', value: 9 });
    expect(r.isError).toBeUndefined();
    const s = store.getState().shapes[0]!;
    if (s.type === 'component') {
      expect(s.data).toEqual({ label: 'b', value: 9 });
      expect(s.module).toBe('KpiCard');
    }
  });

  test('errors on a non-component id', () => {
    const store = createStore();
    const r = setComponentDataOp(store, 'shape:nope', { a: 1 });
    expect(r.isError).toBe(true);
  });
});

describe('rev management', () => {
  test('nextComponentRev exceeds every placed rev', () => {
    const store = createStore();
    placeComponentOp(store, { module: 'A', x: 0, y: 0, rev: 3 });
    placeComponentOp(store, { module: 'B', x: 0, y: 0, rev: 7 });
    expect(nextComponentRev(store)).toBe(8);
  });

  test('bumpAllComponents reloads every instance (so a leaf edit reaches containers)', () => {
    const store = createStore();
    placeComponentOp(store, { module: 'KpiCard', x: 0, y: 0, rev: 1 });
    placeComponentOp(store, { module: 'Dashboard', x: 0, y: 0, rev: 1 });
    const n = bumpAllComponents(store, 5);
    expect(n).toBe(2);
    for (const s of store.getState().shapes) if (s.type === 'component') expect(s.rev).toBe(5);
  });
});
