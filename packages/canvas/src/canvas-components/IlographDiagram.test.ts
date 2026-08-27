import { describe, expect, test } from 'bun:test';

import {
  type Relation,
  type ResolvedEdge,
  type Resource,
  indexModel,
  layerNodes,
  resolveRelations,
  ribbonPath,
  visibleNodes,
  connectedNodes,
  applyPositions,
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

describe('connectedNodes', () => {
  const connected = (relations: Relation[], expanded: Record<string, boolean> = {}) => {
    const nodes = visibleNodes(RESOURCES, expanded);
    return connectedNodes(nodes, relate(relations, expanded)).map((n) => n.id);
  };

  test('drops resources this perspective never relates', () => {
    // `shell -> api` re-routes to `browser -> edge`; d1 is in the model but not in this
    // perspective, and used to land unconnected in layer 0 at the far left.
    expect(connected([{ from: 'shell', to: 'api' }])).toEqual(['browser', 'edge']);
  });

  test('prunes at whatever level is on screen, not just the top', () => {
    // browser is open, so `pad -> api` lands on pad — and shell, its own sibling, is as
    // irrelevant here as d1 is.
    expect(connected([{ from: 'pad', to: 'api' }], { browser: true })).toEqual(['pad', 'edge']);
  });

  test('keeps model order, so a perspective never reshuffles the columns', () => {
    expect(connected([{ from: 'api', to: 'd1' }, { from: 'shell', to: 'api' }]))
      .toEqual(['browser', 'edge', 'd1']);
  });

  test('a perspective that relates nothing shows the model whole, not a blank card', () => {
    // No edges is not "everything is irrelevant" — there is nothing to prune AGAINST, and
    // pruning to empty would render a card with no content at all.
    expect(connected([])).toEqual(['browser', 'edge', 'd1']);
  });

  test('a relation that collapses onto one node prunes like any other absence', () => {
    // shell -> pad is internal to a collapsed browser, so resolveRelations drops it: the
    // perspective ends up relating nothing, and the no-edges rule applies.
    expect(connected([{ from: 'shell', to: 'pad' }])).toEqual(['browser', 'edge', 'd1']);
  });

  test('the far-left column no longer collects the unrelated — the reported symptom', () => {
    const nodes = visibleNodes(RESOURCES, {});
    const edges = relate([{ from: 'shell', to: 'api' }], {});
    const before = layerNodes(nodes, edges);
    const after = layerNodes(connectedNodes(nodes, edges), edges);
    // d1 sat at x=0 beside browser, unconnected; now nothing but browser starts there.
    expect(before.pos.d1!.x).toBe(before.pos.browser!.x);
    expect(after.pos.d1).toBeUndefined();
    expect(Object.keys(after.pos).sort()).toEqual(['browser', 'edge']);
  });
});

// The "Doc reads" perspective from the skills model — the diagram that prompted this.
// Every edge spans the same two columns, so counting inversions IS counting crossings.
const SKILLS: Resource[] = [
  { id: 'skills', name: 'Skills', color: '#4a9eff', children: [
    { id: 'grill', name: 'grill-with-docs' },
    { id: 'tospec', name: 'to-spec' },
    { id: 'totickets', name: 'to-tickets' },
    { id: 'implement', name: 'implement' },
    { id: 'codereview', name: 'code-review' },
    { id: 'tdd', name: 'tdd' },
    { id: 'diagnose', name: 'diagnosing-bugs' },
  ] },
  { id: 'docs', name: 'Config docs', color: '#fb923c', children: [
    { id: 'standards', name: 'standards.md' },
    { id: 'testing', name: 'testing.md' },
    { id: 'delivery', name: 'delivery.md' },
    { id: 'observe', name: 'observe.md' },
  ] },
];

const DOC_READS: Relation[] = [
  { from: 'grill', to: 'delivery' },
  { from: 'tospec', to: 'delivery' },
  { from: 'totickets', to: 'delivery' },
  { from: 'tdd', to: 'testing' },
  { from: 'implement', to: 'testing' },
  { from: 'codereview', to: 'standards' },
  { from: 'diagnose', to: 'observe' },
];

/** Two edges cross when their endpoints are in opposite vertical order. */
const crossings = (pos: Record<string, { y: number }>, edges: ResolvedEdge[]) => {
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!;
      const b = edges[j]!;
      if ((pos[a.from]!.y - pos[b.from]!.y) * (pos[a.to]!.y - pos[b.to]!.y) < 0) n++;
    }
  }
  return n;
};

const docReadsLayout = () => {
  const expanded = { skills: true, docs: true };
  const { byId, parentOf } = indexModel(SKILLS);
  const nodes = visibleNodes(SKILLS, expanded);
  const edges = resolveRelations(DOC_READS, nodes, byId, parentOf);
  const shown = connectedNodes(nodes, edges);
  return { edges, ...layerNodes(shown, edges) };
};

/** The layout as columns of ids, left to right, each top to bottom. */
const columnsOf = (pos: Record<string, { x: number; y: number }>) => {
  const xs = [...new Set(Object.values(pos).map((b) => b.x))].sort((a, b) => a - b);
  return xs.map((x) =>
    Object.entries(pos).filter(([, b]) => b.x === x).sort((a, b) => a[1].y - b[1].y).map(([id]) => id),
  );
};

describe('column ordering (crossing reduction)', () => {
  test('the hairball resolves: model order crosses 10 times, ordered crosses 0', () => {
    const { edges, pos } = docReadsLayout();
    expect(edges).toHaveLength(7);
    expect(crossings(pos, edges)).toBe(0);
  });

  test('readers of one doc end up adjacent, in their doc\'s order', () => {
    // Pinning the arrangement, not just the count: several orders reach zero crossings and
    // the heuristic settles on this one (it moved the DOCS column, leaving the readers close
    // to authoring order, rather than the reverse). Both columns are asserted so a change of
    // optimum is visible rather than silent.
    const { pos } = docReadsLayout();
    expect(columnsOf(pos)).toEqual([
      [
        'grill', 'tospec', 'totickets', // -> delivery
        'codereview', // -> standards
        'implement', 'tdd', // -> testing
        'diagnose', // -> observe
      ],
      ['delivery', 'standards', 'testing', 'observe'],
    ]);
  });

  test('a node with no neighbour in the reference column keeps its relative place', () => {
    // `d1` has no predecessor, so ordering has nothing to place it BY; it must not be
    // shuffled to an arbitrary end just because its median is undefined.
    const nodes = visibleNodes(RESOURCES, {});
    const edges: ResolvedEdge[] = [{ from: 'browser', to: 'edge' }];
    const { pos } = layerNodes(nodes, edges);
    expect(columnsOf(pos)[0]).toEqual(['browser', 'd1']);
  });

  test('ordering is idempotent — a settled layout does not keep moving', () => {
    const first = docReadsLayout();
    const second = docReadsLayout();
    expect(columnsOf(second.pos)).toEqual(columnsOf(first.pos));
  });
});

describe('applyPositions', () => {
  const base = () => layerNodes(visibleNodes(RESOURCES, {}), [{ from: 'browser', to: 'edge' }]);

  test('no overrides is the computed layout, unchanged', () => {
    const laid = base();
    const out = applyPositions(laid.pos, undefined);
    expect(out.pos).toEqual(laid.pos);
    expect(out.width).toBe(laid.width);
    expect(out.height).toBe(laid.height);
    expect(out.origin).toEqual({ x: 0, y: 0 });
  });

  test('a dragged node moves and keeps its size; the others do not budge', () => {
    const laid = base();
    const out = applyPositions(laid.pos, { edge: { x: 500, y: 200 } });
    expect(out.pos.edge).toEqual({ x: 500, y: 200, w: laid.pos.edge!.w, h: laid.pos.edge!.h });
    expect(out.pos.browser).toEqual(laid.pos.browser!);
    expect(out.pos.d1).toEqual(laid.pos.d1!);
  });

  test('the drawing grows so a node dragged past the edge stays on it', () => {
    const laid = base();
    const out = applyPositions(laid.pos, { edge: { x: 900, y: 700 } });
    expect(out.width).toBeGreaterThanOrEqual(900 + laid.pos.edge!.w);
    expect(out.height).toBeGreaterThanOrEqual(700 + laid.pos.edge!.h);
  });

  test('dragging above or left of the origin shifts it rather than clipping', () => {
    const laid = base();
    const out = applyPositions(laid.pos, { browser: { x: -120, y: -60 } });
    expect(out.origin).toEqual({ x: -120, y: -60 });
    // width measures the whole occupied span, so the negative side is inside the viewBox.
    expect(out.width).toBe(laid.width + 120);
  });

  test('an override for a node that is not on screen is ignored', () => {
    // Perspectives and expansion change the node set under a saved position; a stale one
    // must not resurrect a node the layout did not place, nor stretch the drawing to it.
    const laid = base();
    const out = applyPositions(laid.pos, { ghost: { x: 4000, y: 4000 } });
    expect(out.pos.ghost).toBeUndefined();
    expect(out.width).toBe(laid.width);
  });
});
