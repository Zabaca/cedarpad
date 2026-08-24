import { describe, expect, test } from 'bun:test';

import { mintId, normalizeIncomingShape, normalizeShape, parsePage, parseParentId } from './normalize';

// A canvas can hold more than one page: tldraw's context menu offers "Move to page →
// New page", and the page switcher is back. `parentId` stays FRAME-only (its x/y
// contract is parent-relative and pages have no coordinates), so page membership is a
// separate field. A shape reaches us with its page either as `page` (the agent's
// vocabulary) or as a `page:`-prefixed `parentId` (tldraw's own record, for a top-level
// shape) — both mean the same thing.
describe('parsePage', () => {
  test('reads an explicit page field', () => {
    expect(parsePage({ page: 'page:two' })).toBe('page:two');
  });

  test('reads a page:-prefixed parentId, which is how tldraw parents a top-level shape', () => {
    expect(parsePage({ parentId: 'page:two' })).toBe('page:two');
  });

  test('an explicit page wins over parentId, and a frame parent is not a page', () => {
    expect(parsePage({ page: 'page:two', parentId: 'shape:f' })).toBe('page:two');
    expect(parsePage({ parentId: 'shape:f' })).toBeUndefined();
  });

  test('absent, empty, and non-string are all undefined', () => {
    expect(parsePage({})).toBeUndefined();
    expect(parsePage({ page: '' })).toBeUndefined();
    expect(parsePage({ page: 42 })).toBeUndefined();
  });
});

describe('normalize carries the page through', () => {
  test('normalizeShape keeps an explicit page and still drops the page parentId', () => {
    const shape = normalizeShape({ id: 'shape:a', type: 'rectangle', x: 0, y: 0, page: 'page:two' });
    expect(shape.page).toBe('page:two');
    expect(shape.parentId).toBeUndefined();
  });

  test('a shape with no page stays exactly as today — omitted, not defaulted', () => {
    expect(normalizeShape({ id: 'shape:a', type: 'rectangle', x: 0, y: 0 }).page).toBeUndefined();
  });

  test('a framed shape can carry both: the frame parents it, the page holds the frame', () => {
    const shape = normalizeShape({ id: 'shape:a', type: 'rectangle', x: 0, y: 0, parentId: 'shape:f', page: 'page:two' });
    expect(shape.parentId).toBe('shape:f');
    expect(shape.page).toBe('page:two');
  });

  test('incoming image and embed carry the page too', () => {
    expect(normalizeIncomingShape({ id: 'shape:i', type: 'image', x: 0, y: 0, parentId: 'page:two' }).page).toBe('page:two');
    expect(normalizeIncomingShape({ id: 'shape:e', type: 'embed', x: 0, y: 0, parentId: 'page:two' }).page).toBe('page:two');
  });
});

// parentId parsing was previously inlined identically in three places
// (normalizeShape, and the image/embed branches of normalizeIncomingShape).
// These pin the shared rule: keep a `shape:`-prefixed id, drop anything else.
describe('parseParentId', () => {
  test('keeps a shape:-prefixed parentId', () => {
    expect(parseParentId({ parentId: 'shape:f1' })).toBe('shape:f1');
  });

  test('drops a non-shape parent (page:) and a non-string', () => {
    expect(parseParentId({ parentId: 'page:page' })).toBeUndefined();
    expect(parseParentId({ parentId: 42 })).toBeUndefined();
  });

  test('absent parentId is undefined', () => {
    expect(parseParentId({})).toBeUndefined();
  });
});

describe('normalize preserves the parentId rule at every call site', () => {
  test('normalizeShape keeps a frame parent, drops a page parent', () => {
    expect(normalizeShape({ id: 'shape:a', type: 'rectangle', x: 0, y: 0, parentId: 'shape:f' }).parentId).toBe('shape:f');
    expect(normalizeShape({ id: 'shape:b', type: 'rectangle', x: 0, y: 0, parentId: 'page:page' }).parentId).toBeUndefined();
  });

  test('incoming image keeps a frame parent, drops a page parent', () => {
    expect(normalizeIncomingShape({ id: 'shape:i', type: 'image', x: 0, y: 0, parentId: 'shape:f' }).parentId).toBe('shape:f');
    expect(normalizeIncomingShape({ id: 'shape:i', type: 'image', x: 0, y: 0, parentId: 'page:page' }).parentId).toBeUndefined();
  });

  test('incoming embed keeps a frame parent, drops a page parent', () => {
    expect(normalizeIncomingShape({ id: 'shape:e', type: 'embed', x: 0, y: 0, parentId: 'shape:f' }).parentId).toBe('shape:f');
    expect(normalizeIncomingShape({ id: 'shape:e', type: 'embed', x: 0, y: 0, parentId: 'page:page' }).parentId).toBeUndefined();
  });
});

// #239: a component names a mart via dataSource ({kind:'mart', name}), never a URL
// (ADR-0017). normalizeShape must carry this through like every other component field.
describe('normalizeShape: component dataSource', () => {
  test('a component with no dataSource stays exactly as today (backward compatible)', () => {
    const shape = normalizeShape({ id: 'shape:c', type: 'component', x: 0, y: 0, module: 'KpiCard', data: { x: 1 }, rev: 1 });
    expect(shape.type === 'component' && shape.dataSource).toBeUndefined();
  });

  test('a valid mart dataSource is preserved', () => {
    const shape = normalizeShape({
      id: 'shape:c',
      type: 'component',
      x: 0,
      y: 0,
      module: 'KpiCard',
      data: {},
      rev: 1,
      dataSource: { kind: 'mart', name: 'mart_runway' },
    });
    expect(shape.type === 'component' ? shape.dataSource : undefined).toEqual({ kind: 'mart', name: 'mart_runway' });
  });

  test('a malformed dataSource is rejected', () => {
    expect(() =>
      normalizeShape({ id: 'shape:c', type: 'component', x: 0, y: 0, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'url', name: 'x' } }),
    ).toThrow();
  });

  // The module name obeys COMPONENT_NAME_RE (shared/bridge-wire.ts) — the same rule the
  // edge and the filesystem enforce. A name with a path separator, extension or space is
  // rejected at placement, and a plain component name passes.
  test('a module name with a path separator, dot or space is rejected; a plain name passes', () => {
    for (const bad of ['../evil', 'Kpi.tsx', 'has space', 'has/slash']) {
      expect(() =>
        normalizeShape({ id: 'shape:c', type: 'component', x: 0, y: 0, module: bad, data: {}, rev: 1 }),
      ).toThrow();
    }
    const ok = normalizeShape({ id: 'shape:c', type: 'component', x: 0, y: 0, module: 'Kpi_Card-2', data: {}, rev: 1 });
    expect(ok.type === 'component' ? ok.module : null).toBe('Kpi_Card-2');
  });

  // MartName (mart-contract.ts) is the same rule the mart route enforces — a name that
  // could never resolve to a real mart is rejected HERE, at placement, not silently
  // stored and left to fail later at render (CLAUDE.md §7: parse at the boundary).
  test('a mart dataSource with a name that fails MartName is rejected', () => {
    expect(() =>
      normalizeShape({ id: 'shape:c', type: 'component', x: 0, y: 0, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'mart', name: 'Not-Valid!' } }),
    ).toThrow();
  });
});

// #327: minted ids must be unique WITHOUT coordination between writers.
//
// #324 primed a container-global counter from room state, which closed the cold-container
// case but not concurrent minting: two containers priming from the same snapshot both mint
// max+1, and whoever flushes second upserts over the first — no error, the agent reports
// success, a shape is gone.
//
// The `?writer=` query gives each block a SEPARATE module instance, which is what a second
// container process is: its own module state, no shared counter. That is the whole point of
// the test — with a sequential counter both instances mint `shape:agent_1` and collide.
describe('mintId: two independent writers never mint the same id (#327)', () => {
  const freshMinter = (tag: string) => import(`./normalize.ts?writer=${tag}`) as Promise<typeof import('./normalize')>;

  test('two separate container processes minting from scratch produce different ids', async () => {
    const [a, b] = await Promise.all([freshMinter('a'), freshMinter('b')]);
    expect(a.mintId()).not.toBe(b.mintId());
  });

  test('a batch of mints is collision-free within one process too', () => {
    const ids = Array.from({ length: 1000 }, () => mintId());
    expect(new Set(ids).size).toBe(1000);
  });

  test('the id stays a valid, provenance-carrying tldraw shape id', () => {
    expect(mintId()).toMatch(/^shape:agent_[A-Za-z0-9]+$/);
    expect(mintId('cmp')).toMatch(/^shape:cmp_[A-Za-z0-9]+$/);
  });

  test('an id supplied by the caller is still preserved (existing canvases are not rewritten)', () => {
    expect(normalizeShape({ id: 'shape:agent_217', type: 'note', x: 0, y: 0, text: 'old' }).id).toBe('shape:agent_217');
  });
});
