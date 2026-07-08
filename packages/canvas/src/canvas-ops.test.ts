import { describe, expect, test } from 'bun:test';

import { createStore } from './store.ts';
import {
  alignOp,
  attachBatchToChat,
  clearOp,
  connectedOp,
  createShapesOp,
  deleteShapesOp,
  imageSrcOf,
  placeComponentOp,
  readOp,
  updateShapesOp,
  sessionsPlacingModule,
  bumpSharedModule,
} from './canvas-ops.ts';
import { normalizeIncomingShape, normalizeShape } from './normalize.ts';
import type { CanvasShape } from './shapes.ts';

/** The (x, y) of a positionable shape, or null for arrows/draws (no single origin). */
const coordOf = (sh: CanvasShape): { x: number; y: number } | null =>
  sh.type === 'arrow' || sh.type === 'draw' ? null : { x: sh.x, y: sh.y };

describe('canvas ops (the agent tool logic)', () => {
  test('read reports empty, then lists shapes', () => {
    const s = createStore();
    expect(readOp(s).text).toBe('The canvas is empty.');
    createShapesOp(s, [{ type: 'rectangle', x: 0, y: 0, text: 'A' }]);
    expect(readOp(s).text).toContain('1 shape(s)');
  });

  test('read_canvas exposes a component\'s load/render status to the agent', () => {
    // The reason the status feature exists: the agent must be able to SEE that a
    // component it placed failed to come up. Status lives on the model (lifted from
    // the host\'s tldraw meta by the read bridge), so readOp serializes it.
    const s = createStore();
    s.upsert([
      {
        id: 'shape:broken',
        type: 'component',
        x: 0,
        y: 0,
        w: 360,
        h: 260,
        module: 'Broken',
        data: {},
        rev: 1,
        color: 'black',
        status: { phase: 'load_error', message: 'module threw on import', attempts: 3 },
      },
    ]);
    const text = readOp(s).text;
    expect(text).toContain('load_error');
    expect(text).toContain('module threw on import');
  });

  test('read_canvas returns every shape on the canvas', () => {
    const s = createStore();
    s.upsert([
      normalizeShape({ id: 'shape:chat', type: 'chat', x: 0, y: 0 }),
      normalizeShape({ id: 'shape:one', type: 'rectangle', x: 0, y: 0, text: 'A' }),
      normalizeShape({ id: 'shape:two', type: 'rectangle', x: 0, y: 0, text: 'B' }),
    ]);
    const text = readOp(s).text;
    expect(text).toContain('3 shape(s)');
    expect(text).toContain('shape:one');
    expect(text).toContain('shape:two');
  });

  test('create fills defaults and mints ids', () => {
    const s = createStore();
    const r = createShapesOp(s, [{ type: 'rectangle', x: 10, y: 20 }]);
    expect(r.isError).toBeFalsy();
    const shape = s.getState().shapes[0]!;
    expect(shape).toMatchObject({ type: 'rectangle', x: 10, y: 20, w: 160, h: 100, color: 'black' });
    expect(shape.id).toMatch(/^shape:/);
  });

  test('create rejects freehand draw and bad input with a legible error', () => {
    const s = createStore();
    expect(createShapesOp(s, [{ type: 'draw', points: [] }]).isError).toBe(true);
    expect(createShapesOp(s, [{ type: 'rectangle' }]).isError).toBe(true); // missing x/y
    expect(createShapesOp(s, [{ type: 'blob', x: 0, y: 0 }]).isError).toBe(true);
    expect(s.getState().shapes).toHaveLength(0);
  });

  test('update merges only provided fields, preserves the rest, and keeps type', () => {
    const s = createStore();
    createShapesOp(s, [{ type: 'rectangle', x: 0, y: 0, w: 100, h: 50, text: 'hi', color: 'blue' }]);
    const id = s.getState().shapes[0]!.id;
    updateShapesOp(s, [{ id, x: 200, type: 'ellipse' /* ignored */ }]);
    const after = s.getState().shapes[0]!;
    expect(after).toMatchObject({ id, type: 'rectangle', x: 200, w: 100, text: 'hi', color: 'blue' });
  });

  test('update on a missing id errors without mutating', () => {
    const s = createStore();
    const r = updateShapesOp(s, [{ id: 'nope', x: 1 }]);
    expect(r.isError).toBe(true);
    expect(s.getState().version).toBe(0);
  });

  test('delete and clear', () => {
    const s = createStore();
    createShapesOp(s, [{ type: 'note', x: 0, y: 0, text: 'a' }, { type: 'note', x: 50, y: 0, text: 'b' }]);
    const [a] = s.getState().shapes;
    deleteShapesOp(s, [a!.id]);
    expect(s.getState().shapes).toHaveLength(1);
    clearOp(s);
    expect(s.getState().shapes).toHaveLength(0);
  });

  test('align left moves every box to the leftmost edge', () => {
    const s = createStore();
    createShapesOp(s, [
      { type: 'rectangle', x: 100, y: 0, w: 50, h: 50 },
      { type: 'rectangle', x: 300, y: 80, w: 50, h: 50 },
      { type: 'rectangle', x: 220, y: 160, w: 50, h: 50 },
    ]);
    const ids = s.getState().shapes.map((x) => x.id);
    const r = alignOp(s, ids, 'left');
    expect(r.isError).toBeFalsy();
    for (const shape of s.getState().shapes) {
      expect(shape.type === 'rectangle' && shape.x).toBe(100);
    }
  });

  test('align needs at least two alignable shapes', () => {
    const s = createStore();
    createShapesOp(s, [{ type: 'rectangle', x: 0, y: 0 }]);
    const ids = s.getState().shapes.map((x) => x.id);
    expect(alignOp(s, ids, 'left').isError).toBe(true);
  });

  test('every mutation advances the store version that drives sync', () => {
    const s = createStore();
    const v0 = s.getState().version;
    createShapesOp(s, [{ type: 'rectangle', x: 0, y: 0 }]);
    expect(s.getState().version).toBeGreaterThan(v0);
  });

  describe('chat-origin: tuck beside the chat + link with an arrow', () => {
    const seedChat = () => {
      const s = createStore();
      s.upsert([{ id: 'shape:chatA', type: 'chat', color: 'black', x: 1000, y: 200, w: 380, h: 460, title: 'Chat A' }]);
      return s;
    };

    test('a created shape lands to the left of the chat with a bound link arrow', () => {
      const s = seedChat();
      createShapesOp(s, [{ type: 'rectangle', x: 100, y: 100, w: 160, h: 100 }], 'shape:chatA');
      const shapes = s.getState().shapes;
      const rect = shapes.find((x) => x.type === 'rectangle');
      const arrow = shapes.find((x) => x.type === 'arrow');
      // Tucked just left of the chat (1000 - 60 gap - 160 width = 780), top-aligned.
      expect(rect?.type === 'rectangle' && rect.x).toBe(780);
      expect(rect?.type === 'rectangle' && rect.y).toBe(200);
      // A grey arrow bound chat -> new shape.
      expect(arrow?.type === 'arrow' && arrow.startShapeId).toBe('shape:chatA');
      expect(arrow?.type === 'arrow' && arrow.endShapeId).toBe(rect?.id);
      expect(arrow?.color).toBe('grey');
    });

    test('every new shape in a batch gets its own link arrow', () => {
      const s = seedChat();
      createShapesOp(s, [
        { type: 'rectangle', x: 0, y: 0 },
        { type: 'ellipse', x: 300, y: 0 },
      ], 'shape:chatA');
      const arrows = s.getState().shapes.filter((x) => x.type === 'arrow');
      expect(arrows.length).toBe(2);
      expect(arrows.every((a) => a.type === 'arrow' && a.startShapeId === 'shape:chatA')).toBe(true);
    });

    test('auto-tuck searches BOTH axes: a blocked left column wraps to the next column, not far down', () => {
      const s = seedChat(); // chat at x:1000 y:200 w:380 h:460
      // Fill the immediate left column (x≈780, spanning the chat's full height) so the
      // nearest slot there is blocked. Old behavior: march straight down (y >> 200).
      // New behavior: wrap one column further left, staying at the chat's top.
      s.upsert([{ id: 'shape:block', type: 'rectangle', color: 'black', x: 760, y: 180, w: 240, h: 520, text: '' }]);
      createShapesOp(s, [{ type: 'rectangle', x: 0, y: 0, w: 160, h: 100 }], 'shape:chatA');
      const rect = s.getState().shapes.find((x) => x.type === 'rectangle' && x.id !== 'shape:block');
      // Stayed near the chat's top row, just wrapped left of the blocked column.
      expect(rect?.type === 'rectangle' && rect.y).toBe(200);
      expect(rect?.type === 'rectangle' && (rect.x as number)).toBeLessThan(780);
    });

    test('without an origin chat, shapes keep their coordinates and get no link', () => {
      const s = seedChat();
      createShapesOp(s, [{ type: 'rectangle', x: 100, y: 100 }]);
      const rect = s.getState().shapes.find((x) => x.type === 'rectangle');
      expect(rect?.type === 'rectangle' && rect.x).toBe(100);
      expect(s.getState().shapes.some((x) => x.type === 'arrow')).toBe(false);
    });

    test('an unknown origin chat is a no-op (no link, original coords)', () => {
      const s = createStore();
      createShapesOp(s, [{ type: 'rectangle', x: 100, y: 100 }], 'shape:missing');
      const rect = s.getState().shapes.find((x) => x.type === 'rectangle');
      expect(rect?.type === 'rectangle' && rect.x).toBe(100);
      expect(s.getState().shapes.some((x) => x.type === 'arrow')).toBe(false);
    });
  });

  describe('attachBatchToChat: the single attach seam (position + root link)', () => {
    const chatOnCanvas = () => {
      const s = createStore();
      s.upsert([normalizeShape({ id: 'shape:chat', type: 'chat', color: 'black', x: 1000, y: 200, w: 380, h: 460, title: 'Chat' })]);
      return s;
    };
    const batch = () => [
      normalizeShape({ type: 'rectangle', x: 100, y: 100, w: 160, h: 100 }),
      normalizeShape({ type: 'ellipse', x: 300, y: 100, w: 160, h: 100 }),
    ];

    test('chat-missing => batch identity: length unchanged, no arrows', () => {
      const s = createStore(); // no chat on the canvas
      const made = batch();
      const out = attachBatchToChat(s, made, 'shape:missing', { preservePosition: false });
      expect(out).toBe(made); // same array reference, returned untouched
      expect(out).toHaveLength(2);
      expect(out.some((sh) => sh.type === 'arrow')).toBe(false);
    });

    test('every root shape is linked back to the chat with a grey arrow', () => {
      const s = chatOnCanvas();
      const out = attachBatchToChat(s, batch(), 'shape:chat', { preservePosition: true });
      const arrows = out.filter((sh) => sh.type === 'arrow');
      expect(arrows).toHaveLength(2); // one root link per non-arrow shape
      expect(arrows.every((a) => a.type === 'arrow' && a.startShapeId === 'shape:chat')).toBe(true);
    });

    test('preservePosition: true => every input shape keeps x/y, arrows appended', () => {
      const s = chatOnCanvas();
      const made = batch();
      const before = new Map(made.map((sh) => [sh.id, coordOf(sh)]));
      const out = attachBatchToChat(s, made, 'shape:chat', { preservePosition: true });
      for (const [id, xy] of before) {
        const after = out.find((sh) => sh.id === id)!;
        expect(coordOf(after)).toEqual(xy); // coords untouched
      }
      expect(out.filter((sh) => sh.type === 'arrow')).toHaveLength(2);
    });

    test('preservePosition: false => batch tucked (positions move), root arrows appended', () => {
      const s = chatOnCanvas();
      const made = batch();
      const before = new Map(made.map((sh) => [sh.id, coordOf(sh)]));
      const out = attachBatchToChat(s, made, 'shape:chat', { preservePosition: false });
      const moved = [...before].some(([id, xy]) => {
        const after = out.find((sh) => sh.id === id)!;
        return JSON.stringify(coordOf(after)) !== JSON.stringify(xy);
      });
      expect(moved).toBe(true); // the tuck heuristic shifted the batch
      expect(out.filter((sh) => sh.type === 'arrow')).toHaveLength(2);
    });

    test('roots rule: a batch with one internal arrow links exactly ONE root to the chat', () => {
      const s = chatOnCanvas();
      const a = normalizeShape({ type: 'rectangle', x: 0, y: 0, w: 100, h: 100 });
      const b = normalizeShape({ type: 'rectangle', x: 200, y: 0, w: 100, h: 100 });
      const internal = normalizeShape({ type: 'arrow', color: 'grey', startShapeId: a.id, endShapeId: b.id });
      const out = attachBatchToChat(s, [a, b, internal], 'shape:chat', { preservePosition: true });
      // Link arrows are those starting at the chat; the internal one starts at `a`.
      const linkArrows = out.filter((sh) => sh.type === 'arrow' && sh.startShapeId === 'shape:chat');
      expect(linkArrows).toHaveLength(1); // only `a` is a root (`b` is targeted by the internal arrow)
      expect(linkArrows[0]!.type === 'arrow' && linkArrows[0]!.endShapeId).toBe(a.id);
      expect(out.filter((sh) => sh.type === 'arrow')).toHaveLength(2); // internal + one root link
    });
  });

  describe('placeComponentOp routes attach through the seam (no inline duplication)', () => {
    test('a missing origin chat is the seam no-op: shape upserted unchanged, no link', () => {
      const s = createStore(); // the chat id below was never added to the canvas
      const r = placeComponentOp(s, { module: 'KpiCard', x: 700, y: 680, w: 360, h: 260, rev: 1 }, 'shape:missing');
      expect(r.isError).toBeUndefined();
      const shapes = s.getState().shapes;
      // The new chat-missing guard: no dangling link arrow against a chat that isn't there
      // (pre-migration, the honor-coords branch linked unconditionally).
      expect(shapes).toHaveLength(1);
      const comp = shapes[0]!;
      expect(comp.type === 'component' && comp.x).toBe(700); // coords untouched
      expect(comp.type === 'component' && comp.y).toBe(680);
      expect(shapes.some((sh) => sh.type === 'arrow')).toBe(false);
    });

    test('placeComponentOp and createShapesOp attach identically', () => {
      const seedChat = () => {
        const st = createStore();
        st.upsert([normalizeShape({ id: 'shape:chat', type: 'chat', color: 'black', x: 1000, y: 200, w: 380, h: 460, title: 'Chat' })]);
        return st;
      };
      // The same fresh batch (one root shape) attached two ways against the same chat.
      const viaCreate = seedChat();
      createShapesOp(viaCreate, [{ type: 'rectangle', x: 0, y: 0, w: 160, h: 100 }], 'shape:chat');
      const viaPlace = seedChat();
      placeComponentOp(viaPlace, { module: 'KpiCard', x: 0, y: 0, w: 360, h: 260, rev: 1 }, 'shape:chat');

      // Parity is on the attach OUTCOME (the arrow set), not the shape ids/coords.
      const attachShape = (st: ReturnType<typeof createStore>) => {
        const arrows = st.getState().shapes.filter((sh) => sh.type === 'arrow');
        return {
          arrowCount: arrows.length,
          starts: arrows.map((a) => a.type === 'arrow' && a.startShapeId),
          colors: arrows.map((a) => a.color),
        };
      };
      expect(attachShape(viaPlace)).toEqual(attachShape(viaCreate));
      // And concretely: exactly one grey link from the chat.
      expect(attachShape(viaPlace)).toEqual({ arrowCount: 1, starts: ['shape:chat'], colors: ['grey'] });
    });
  });

  describe('cross-canvas shared rev-bump: the "who reloads" set (#55)', () => {
    // A session is anything carrying a store; the target computation is pure over the set.
    const sessionWith = (id: string, modules: string[]) => {
      const store = createStore();
      store.upsert(
        modules.map((m, i) => normalizeShape({ id: `shape:${id}-${i}`, type: 'component', x: 0, y: 0, w: 360, h: 260, module: m, data: {}, rev: 1 })),
      );
      return { canvasId: id, store };
    };

    test('sessionsPlacingModule selects EXACTLY the sessions that placed the module', () => {
      const a = sessionWith('a', ['Shared', 'Local']);
      const b = sessionWith('b', ['Other']);
      const c = sessionWith('c', ['Shared']);
      const sessions = [a, b, c];
      expect(sessionsPlacingModule(sessions, 'Shared').map((s) => s.canvasId)).toEqual(['a', 'c']);
      expect(sessionsPlacingModule(sessions, 'Other').map((s) => s.canvasId)).toEqual(['b']);
      expect(sessionsPlacingModule(sessions, 'Nobody')).toHaveLength(0);
    });

    test('bumpSharedModule bumps rev on every placing session, leaves the rest untouched', () => {
      const a = sessionWith('a', ['Shared']);
      const b = sessionWith('b', ['Other']);
      const revBefore = (s: { store: ReturnType<typeof createStore> }) =>
        s.store.getState().shapes.map((sh) => (sh.type === 'component' ? sh.rev : -1));
      expect(revBefore(a)).toEqual([1]);

      const reloaded = bumpSharedModule([a, b], 'Shared');
      expect(reloaded).toBe(1); // exactly canvas a
      expect(revBefore(a)[0]!).toBeGreaterThan(1); // a's instance re-imported
      expect(revBefore(b)).toEqual([1]); // b never placed it → unchanged
    });
  });

  describe('connectedOp: a chat reads its own connected subgraph', () => {
    // chat -> kpi -> note (outgoing chain), and ext -> chat (incoming). plus a
    // lone unrelated rectangle that no arrow touches.
    const seedGraph = () => {
      const s = createStore();
      const arrow = (id: string, from: string, to: string) =>
        ({ id, type: 'arrow', color: 'grey', x1: 0, y1: 0, x2: 0, y2: 0, text: '', startShapeId: from, endShapeId: to }) as const;
      s.upsert([
        { id: 'shape:chat', type: 'chat', color: 'black', x: 0, y: 0, w: 380, h: 460, title: 'Chat' },
        { id: 'shape:kpi', type: 'component', color: 'black', x: 0, y: 0, w: 360, h: 260, module: 'KpiCard', data: { value: 42 }, rev: 1 },
        { id: 'shape:note', type: 'note', color: 'yellow', x: 0, y: 0, text: 'hello' },
        { id: 'shape:ext', type: 'rectangle', color: 'blue', x: 0, y: 0, w: 100, h: 100, text: 'ext' },
        { id: 'shape:lone', type: 'rectangle', color: 'red', x: 0, y: 0, w: 100, h: 100, text: 'lone' },
        arrow('shape:a1', 'shape:chat', 'shape:kpi'),
        arrow('shape:a2', 'shape:kpi', 'shape:note'),
        arrow('shape:a3', 'shape:ext', 'shape:chat'),
      ]);
      return s;
    };

    const graphOf = (r: { text: string }) => JSON.parse(r.text.slice(r.text.indexOf('{'))) as { root: string; nodes: Array<{ id: string }>; edges: Array<{ id: string }> };

    test('both directions (default) returns the whole connected group with full state, excludes unrelated', () => {
      const g = graphOf(connectedOp(seedGraph(), 'shape:chat'));
      const ids = g.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(['shape:chat', 'shape:ext', 'shape:kpi', 'shape:note']);
      expect(ids).not.toContain('shape:lone');
      const kpi = g.nodes.find((n) => n.id === 'shape:kpi') as { data?: { value?: number } };
      expect(kpi.data?.value).toBe(42); // full component state travels with the node
      expect(g.edges.length).toBe(3);
    });

    test('depth 1 returns only direct neighbors', () => {
      const g = graphOf(connectedOp(seedGraph(), 'shape:chat', { depth: 1 }));
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['shape:chat', 'shape:ext', 'shape:kpi']);
    });

    test('direction out follows only outgoing arrows', () => {
      const g = graphOf(connectedOp(seedGraph(), 'shape:chat', { direction: 'out' }));
      const ids = g.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(['shape:chat', 'shape:kpi', 'shape:note']); // not ext (incoming)
    });

    test('unknown root is an error', () => {
      expect(connectedOp(seedGraph(), 'shape:nope').isError).toBe(true);
    });
  });

  describe('image shapes: redacted in reads, retrievable by id, human-only', () => {
    const bigSrc = `data:image/png;base64,${'A'.repeat(5000)}`;
    const seedImage = () => {
      const s = createStore();
      s.upsert([{ id: 'shape:pic', type: 'image', color: 'black', x: 0, y: 0, w: 100, h: 80, src: bigSrc, alt: 'screenshot' }]);
      return s;
    };

    test('read_canvas redacts the data URL but keeps the rest of the image state', () => {
      const txt = readOp(seedImage()).text;
      expect(txt).not.toContain('AAAA'); // the huge base64 never reaches the agent's context
      expect(txt).toContain('read_image'); // points the agent at the tool to view it
      expect(txt).toContain('shape:pic');
      expect(txt).toContain('screenshot'); // alt + geometry still visible
    });

    test('imageSrcOf returns the full data URL for the read_image tool', () => {
      expect(imageSrcOf(seedImage(), 'shape:pic')).toBe(bigSrc);
      expect(imageSrcOf(seedImage(), 'shape:missing')).toBeNull();
    });

    test('the agent cannot create an image (human-only); the browser can', () => {
      expect(() => normalizeShape({ type: 'image', x: 0, y: 0, src: bigSrc })).toThrow(/human/i);
      const fromBrowser = normalizeIncomingShape({ id: 'shape:pic2', type: 'image', x: 1, y: 2, w: 10, h: 10, src: bigSrc, alt: 'ok' });
      expect(fromBrowser).toMatchObject({ id: 'shape:pic2', type: 'image', src: bigSrc, alt: 'ok' });
    });
  });
});
