import { describe, expect, test } from 'bun:test';

import {
  type Relation,
  type Resource,
  indexModel,
  layerNodes,
  resolveRelations,
  ribbonPath,
  visibleNodes,
} from './IlographDiagram.tsx';

const RESOURCES: Resource[] = [
  { id: 'browser', name: 'Browser', color: '#4f9cf9', children: [
    { id: 'shell', name: 'Shell' },
    { id: 'pad', name: 'Pad' },
  ] },
  { id: 'edge', name: 'Edge', color: '#2dd4bf', children: [{ id: 'api', name: 'API' }] },
  { id: 'd1', name: 'D1', color: '#f472b6' },
];

const relate = (relations: Relation[], expanded: Record<string, boolean>) => {
  const { byId, parentOf } = indexModel(RESOURCES);
  return resolveRelations(relations, visibleNodes(RESOURCES, expanded), byId, parentOf);
};

describe('indexModel', () => {
  test('flattens the tree and gives children their parent id and colour', () => {
    const { byId, parentOf } = indexModel(RESOURCES);
    expect(Object.keys(byId).sort()).toEqual(['api', 'browser', 'd1', 'edge', 'pad', 'shell']);
    expect(parentOf).toEqual({ shell: 'browser', pad: 'browser', api: 'edge' });
    expect(byId.shell.color).toBe('#4f9cf9');
  });
});

describe('visibleNodes', () => {
  test('collapsed: one node per top-level resource, flagged as expandable', () => {
    const nodes = visibleNodes(RESOURCES, {});
    expect(nodes.map((n) => n.id)).toEqual(['browser', 'edge', 'd1']);
    expect(nodes.map((n) => n.hasChildren)).toEqual([true, true, false]);
  });

  test('expanded: the parent is replaced by its children', () => {
    expect(visibleNodes(RESOURCES, { browser: true }).map((n) => n.id)).toEqual(['shell', 'pad', 'edge', 'd1']);
  });
});

describe('resolveRelations', () => {
  test('collapsed: child endpoints re-route up to the visible parent', () => {
    expect(relate([{ from: 'shell', to: 'api', label: 'fetch' }], {})).toEqual([
      { from: 'browser', to: 'edge', label: 'fetch' },
    ]);
  });

  test('expanded: the relation lands on the specific child', () => {
    expect(relate([{ from: 'shell', to: 'api' }], { browser: true })).toEqual([
      { from: 'shell', to: 'edge', label: undefined },
    ]);
  });

  test('a relation wholly inside one collapsed parent disappears', () => {
    expect(relate([{ from: 'shell', to: 'pad' }], {})).toEqual([]);
  });

  test('two relations collapsing onto the same pair dedupe, keeping the first label', () => {
    const edges = relate([{ from: 'shell', to: 'api', label: 'fetch' }, { from: 'pad', to: 'api', label: 'sse' }], {});
    expect(edges).toEqual([{ from: 'browser', to: 'edge', label: 'fetch' }]);
  });

  test('a parent endpoint drops onto its first visible child when expanded', () => {
    expect(relate([{ from: 'd1', to: 'browser' }], { browser: true })).toEqual([
      { from: 'd1', to: 'shell', label: undefined },
    ]);
  });

  test('unknown ids are dropped rather than throwing', () => {
    expect(relate([{ from: 'nope', to: 'd1' }], {})).toEqual([]);
  });
});

describe('layerNodes', () => {
  test('a chain lays out left to right, one node per column', () => {
    const nodes = visibleNodes(RESOURCES, {});
    const edges = relate([{ from: 'shell', to: 'api' }, { from: 'api', to: 'd1' }], {});
    const { pos, width } = layerNodes(nodes, edges);
    expect(pos.browser.x).toBeLessThan(pos.edge.x);
    expect(pos.edge.x).toBeLessThan(pos.d1.x);
    expect(width).toBeGreaterThan(0);
  });

  test('unrelated nodes share the first column and stack vertically', () => {
    const { pos } = layerNodes(visibleNodes(RESOURCES, {}), []);
    expect(pos.browser.x).toBe(pos.edge.x);
    expect(pos.browser.y).toBeLessThan(pos.edge.y);
  });

  test('a cycle settles instead of looping forever', () => {
    const edges = relate([{ from: 'shell', to: 'api' }, { from: 'api', to: 'shell' }], {});
    const { pos } = layerNodes(visibleNodes(RESOURCES, {}), edges);
    expect(Number.isFinite(pos.browser.x)).toBe(true);
    expect(Number.isFinite(pos.edge.x)).toBe(true);
  });
});

describe('ribbonPath', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };

  test('a forward relation is a single S-curve between the facing edges', () => {
    const d = ribbonPath(a, { x: 300, y: 0, w: 100, h: 50 });
    expect(d.startsWith('M100,25')).toBe(true);
    expect(d).toContain('C');
    expect(d.endsWith('300,25')).toBe(true);
  });

  test('a backwards relation loops under both boxes instead of crossing them', () => {
    const d = ribbonPath(a, { x: -300, y: 0, w: 100, h: 50 });
    expect(d.startsWith('M50,50')).toBe(true);
    expect(d).toContain('84'); // routed below both boxes: max(bottom) + 34
  });
});
