import { describe, expect, test } from 'bun:test';

import type { TLShape } from 'tldraw';

import type { CanvasShape } from './shapes';
import {
  type ArrowBindingsView,
  arrowTerminal,
  canon,
  clampColor,
  fromTldrawShape,
  toTldrawPartial,
} from './tldraw-conventions';

// An identity encoder: keeps the assembly assertions free of tldraw's real
// richText doc shape so we can compare the wrapped plain text directly.
const enc = (plain: string) => ({ kind: 'plain', text: plain });

// Helper to read back the props the assembly built (the pure module casts to
// tldraw's TLShapePartial union, which is opaque here).
const partial = (s: CanvasShape) => toTldrawPartial(s, enc) as unknown as { type: string; x: number; y: number; props: Record<string, unknown> } | null;

describe('clampColor', () => {
  test('clamps a light-* variant down to its base palette color', () => {
    expect(clampColor('light-blue')).toBe('blue');
  });

  test('clamps white onto grey', () => {
    expect(clampColor('white')).toBe('grey');
  });

  test('falls back to black for an unknown color', () => {
    expect(clampColor('not-a-color')).toBe('black');
  });

  test('passes an already-canonical palette color through unchanged', () => {
    expect(clampColor('violet')).toBe('violet');
  });
});

describe('arrowTerminal', () => {
  test('unbound terminal = shape origin + local offset', () => {
    expect(arrowTerminal({ x: 10, y: 20 }, { x: 3, y: 4 }, false)).toEqual({ x: 13, y: 24 });
  });

  test('bound terminal collapses to the {0,0} placeholder', () => {
    expect(arrowTerminal({ x: 10, y: 20 }, { x: 3, y: 4 }, true)).toEqual({ x: 0, y: 0 });
  });
});

describe('toTldrawPartial', () => {
  test('rectangle -> geo (rectangle) with sized, colored, encoded props', () => {
    const p = partial({ id: 'shape:r', type: 'rectangle', x: 5, y: 6, w: 30, h: 40, color: 'blue', text: 'hi' });
    expect(p).toMatchObject({
      type: 'geo',
      x: 5,
      y: 6,
      props: { geo: 'rectangle', w: 30, h: 40, color: 'blue', richText: { kind: 'plain', text: 'hi' } },
    });
  });

  test('ellipse -> geo (ellipse)', () => {
    const p = partial({ id: 'shape:e', type: 'ellipse', x: 1, y: 2, w: 10, h: 20, color: 'green', text: '' });
    expect(p?.type).toBe('geo');
    expect(p?.props.geo).toBe('ellipse');
  });

  test('text -> text with color + encoded richText', () => {
    const p = partial({ id: 'shape:t', type: 'text', x: 7, y: 8, color: 'red', text: 'yo' });
    expect(p).toMatchObject({ type: 'text', x: 7, y: 8, props: { color: 'red', richText: { kind: 'plain', text: 'yo' } } });
  });

  test('note -> note with color + encoded richText', () => {
    const p = partial({ id: 'shape:n', type: 'note', x: 9, y: 10, color: 'yellow', text: 'pin' });
    expect(p).toMatchObject({ type: 'note', x: 9, y: 10, props: { color: 'yellow', richText: { kind: 'plain', text: 'pin' } } });
  });

  test('arrow -> arrow anchored at origin with start/end terminals', () => {
    const p = partial({ id: 'shape:a', type: 'arrow', x1: 1, y1: 2, x2: 3, y2: 4, color: 'orange', text: 'edge' });
    expect(p).toMatchObject({
      type: 'arrow',
      x: 0,
      y: 0,
      props: { color: 'orange', start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, richText: { kind: 'plain', text: 'edge' } },
    });
  });

  test('component -> component with module/data/rev props (no richText)', () => {
    const p = partial({ id: 'shape:c', type: 'component', x: 2, y: 3, w: 360, h: 260, module: 'KpiCard', data: { v: 1 }, rev: 4, color: 'black' });
    expect(p).toMatchObject({ type: 'component', x: 2, y: 3, props: { w: 360, h: 260, module: 'KpiCard', data: { v: 1 }, rev: 4 } });
    expect(p?.props.richText).toBeUndefined();
  });

  test('chat -> chat with w/h/title props (the id is the chat id)', () => {
    const p = partial({ id: 'shape:k', type: 'chat', x: 8, y: 9, w: 380, h: 460, title: 'Chat 2', color: 'black' });
    expect(p).toMatchObject({ type: 'chat', x: 8, y: 9, props: { w: 380, h: 460, title: 'Chat 2' } });
  });

  test('frame -> frame with w/h/name props', () => {
    const p = partial({ id: 'shape:f', type: 'frame', x: 1, y: 2, w: 320, h: 240, name: 'Group A', color: 'black' });
    expect(p).toMatchObject({ type: 'frame', x: 1, y: 2, props: { w: 320, h: 240, name: 'Group A' } });
  });

  test('parentId is attached to the partial (frame child round-trips back inside)', () => {
    const p = partial({ id: 'shape:c', type: 'rectangle', x: 5, y: 6, w: 10, h: 10, color: 'black', text: '', parentId: 'shape:f' });
    expect((p as { parentId?: string }).parentId).toBe('shape:f');
  });

  test('a top-level shape gets no parentId (tldraw parents it to the canvas)', () => {
    const p = partial({ id: 'shape:c', type: 'rectangle', x: 5, y: 6, w: 10, h: 10, color: 'black', text: '' });
    expect((p as { parentId?: string }).parentId).toBeUndefined();
  });

  test('a legacy shape still carrying a pageId round-trips without it (the field is ignored)', () => {
    const legacy = { id: 'shape:c', type: 'rectangle', x: 5, y: 6, w: 10, h: 10, color: 'black', text: '', pageId: 'page:two' };
    const p = partial(legacy as never);
    expect((p as { parentId?: string }).parentId).toBeUndefined();
  });

  test('image -> image referencing a deterministic asset id (pixels not in the partial)', () => {
    const p = partial({ id: 'shape:img1', type: 'image', x: 4, y: 5, w: 120, h: 80, src: 'data:image/png;base64,AAAA', alt: 'shot', color: 'black' });
    expect(p).toMatchObject({ type: 'image', x: 4, y: 5, props: { w: 120, h: 80, assetId: 'asset:img1', altText: 'shot' } });
    expect(JSON.stringify(p)).not.toContain('AAAA'); // src never rides in the shape partial
  });

  test('draw -> null (freehand is never recreated from the model)', () => {
    const draw: CanvasShape = { id: 'shape:d', type: 'draw', color: 'black', points: [[0, 0], [1, 1]] };
    expect(toTldrawPartial(draw, enc)).toBeNull();
  });

  test('clamps an off-palette color onto the palette through this path', () => {
    // color is typed ShapeColor; force an off-palette runtime value to exercise the clamp.
    const p = partial({ id: 'shape:r', type: 'rectangle', x: 0, y: 0, w: 1, h: 1, color: 'light-blue' as never, text: '' });
    expect(p?.props.color).toBe('blue');
  });
});

// Build a minimal tldraw shape literal + decode it. The pure decoder reads only
// `type` / `id` / `x` / `y` / `props`, so a hand-built object cast to TLShape is
// enough — no live Editor.
const decode = (
  shape: Record<string, unknown>,
  ctx: { plaintext: string; arrowBindings?: ArrowBindingsView; imageSrc?: string },
): CanvasShape | null => fromTldrawShape(shape as unknown as TLShape, ctx);

describe('fromTldrawShape', () => {
  test('geo (rectangle) -> rectangle with sized fields + injected plaintext', () => {
    const s = decode(
      { id: 'shape:r', type: 'geo', x: 5, y: 6, props: { geo: 'rectangle', w: 30, h: 40, color: 'blue' } },
      { plaintext: 'hi' },
    );
    expect(s).toEqual({ id: 'shape:r', type: 'rectangle', x: 5, y: 6, w: 30, h: 40, color: 'blue', text: 'hi' });
  });

  test('geo (ellipse) -> ellipse', () => {
    const s = decode(
      { id: 'shape:e', type: 'geo', x: 0, y: 0, props: { geo: 'ellipse', w: 10, h: 20, color: 'green' } },
      { plaintext: '' },
    );
    expect(s).toMatchObject({ id: 'shape:e', type: 'ellipse', w: 10, h: 20, color: 'green' });
  });

  test('text -> text with injected plaintext', () => {
    const s = decode({ id: 'shape:t', type: 'text', x: 7, y: 8, props: { color: 'red' } }, { plaintext: 'yo' });
    expect(s).toEqual({ id: 'shape:t', type: 'text', x: 7, y: 8, color: 'red', text: 'yo' });
  });

  test('note -> note with injected plaintext', () => {
    const s = decode({ id: 'shape:n', type: 'note', x: 9, y: 10, props: { color: 'yellow' } }, { plaintext: 'pin' });
    expect(s).toEqual({ id: 'shape:n', type: 'note', x: 9, y: 10, color: 'yellow', text: 'pin' });
  });

  test('arrow (unbound) -> terminals are shape origin + local offset', () => {
    const s = decode(
      { id: 'shape:a', type: 'arrow', x: 100, y: 200, props: { color: 'orange', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } },
      { plaintext: 'edge', arrowBindings: {} },
    );
    expect(s).toEqual({ id: 'shape:a', type: 'arrow', x1: 101, y1: 202, x2: 103, y2: 204, color: 'orange', text: 'edge' });
  });

  test('component -> component with module/data/rev (off-palette color clamped, no plaintext used)', () => {
    const s = decode(
      { id: 'shape:c', type: 'component', x: 2, y: 3, props: { w: 360, h: 260, module: 'KpiCard', data: { v: 1 }, rev: 4, color: 'black' } },
      { plaintext: 'ignored' },
    );
    // No meta.status on the shape → no `status` on the model (the back-compat case).
    expect(s).toEqual({ id: 'shape:c', type: 'component', x: 2, y: 3, w: 360, h: 260, module: 'KpiCard', data: { v: 1 }, rev: 4, color: 'black' });
  });

  test('component lifts meta.status onto the model — the read_canvas bridge', () => {
    // The whole point of the status feature: the host writes the load/render lifecycle
    // to tldraw `meta.status`, and read_canvas must expose it so the agent can see a
    // component it placed failed. Without the bridge in `case 'component'`, this status
    // is dropped on the way to the model and the agent stays blind.
    const s = decode(
      {
        id: 'shape:c2',
        type: 'component',
        x: 0,
        y: 0,
        props: { w: 360, h: 260, module: 'Broken', data: {}, rev: 1, color: 'black' },
        meta: { status: { phase: 'load_error', message: 'boom', attempts: 3 } },
      },
      { plaintext: '' },
    );
    expect(s).toMatchObject({
      id: 'shape:c2',
      type: 'component',
      status: { phase: 'load_error', message: 'boom', attempts: 3 },
    });
  });

  test('chat -> chat with w/h/title (so dragging a chat card is pushed, not dropped to null)', () => {
    const s = decode(
      { id: 'shape:k', type: 'chat', x: 8, y: 9, props: { w: 380, h: 460, title: 'Chat 2', color: 'black' } },
      { plaintext: 'ignored' },
    );
    expect(s).toEqual({ id: 'shape:k', type: 'chat', x: 8, y: 9, w: 380, h: 460, title: 'Chat 2', color: 'black' });
  });

  test('image -> image, pulling src from ctx (resolved by the shell from the asset)', () => {
    const s = decode(
      { id: 'shape:img2', type: 'image', x: 4, y: 5, props: { w: 120, h: 80, assetId: 'asset:img2', altText: 'shot' } },
      { plaintext: '', imageSrc: 'data:image/png;base64,ZZZ' },
    );
    expect(s).toEqual({ id: 'shape:img2', type: 'image', x: 4, y: 5, w: 120, h: 80, src: 'data:image/png;base64,ZZZ', alt: 'shot', color: 'black' });
  });

  test('frame -> frame with w/h/name (so frames are pushed, not dropped to null)', () => {
    const s = decode(
      { id: 'shape:f', type: 'frame', x: 1, y: 2, props: { w: 320, h: 240, name: 'Group A', color: 'black' } },
      { plaintext: 'ignored' },
    );
    expect(s).toEqual({ id: 'shape:f', type: 'frame', x: 1, y: 2, w: 320, h: 240, name: 'Group A', color: 'black' });
  });

  test('a shape parented to a frame keeps its parentId; a page parent is dropped', () => {
    const child = decode(
      { id: 'shape:c', type: 'geo', x: 5, y: 6, parentId: 'shape:f', props: { geo: 'rectangle', w: 10, h: 10, color: 'blue' } },
      { plaintext: '' },
    );
    expect((child as { parentId?: string }).parentId).toBe('shape:f');
    const top = decode(
      { id: 'shape:t', type: 'geo', x: 0, y: 0, parentId: 'page:page', props: { geo: 'rectangle', w: 10, h: 10, color: 'blue' } },
      { plaintext: '' },
    );
    expect((top as { parentId?: string }).parentId).toBeUndefined();
  });

  test('draw -> draw with page-space points (plaintext unused)', () => {
    const s = decode(
      { id: 'shape:d', type: 'draw', x: 10, y: 20, props: { color: 'grey', segments: [{ points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] }] } },
      { plaintext: 'ignored' },
    );
    expect(s).toEqual({ id: 'shape:d', type: 'draw', color: 'grey', points: [[11, 21], [12, 23]] });
  });

  test('a bound start terminal collapses to {0,0}, regardless of shape.x + props.start.x', () => {
    const s = decode(
      { id: 'shape:a', type: 'arrow', x: 100, y: 200, props: { color: 'black', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } },
      { plaintext: '', arrowBindings: { start: { toId: 'shape:a' } } },
    ) as { x1: number; y1: number; x2: number; y2: number };
    expect(s.x1).toBe(0);
    expect(s.y1).toBe(0);
    // The end terminal is still unbound, so it keeps origin + local offset.
    expect(s.x2).toBe(103);
    expect(s.y2).toBe(204);
  });

  test('the same arrow with empty bindings keeps the unbound start terminal', () => {
    const s = decode(
      { id: 'shape:a', type: 'arrow', x: 100, y: 200, props: { color: 'black', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } },
      { plaintext: '', arrowBindings: {} },
    ) as { x1: number; y1: number };
    expect(s.x1).toBe(100 + 1);
    expect(s.y1).toBe(200 + 2);
  });

  test('unknown tldraw shape type -> null', () => {
    expect(decode({ id: 'shape:v', type: 'video', x: 0, y: 0, props: {} }, { plaintext: '' })).toBeNull();
  });
});

// The seam this slice closes: a CanvasShape encoded to a tldraw partial and
// decoded back must canon-equal the original. A true identity encoder is enough
// because the decoder reads its plaintext from `ctx`, never from props.richText.
const identityEncoder = (plain: string) => plain;

// Promote a TLShapePartial to the minimal TLShape the pure decoder needs: it
// reads only `type` / `id` / `x` / `y` / `props`, plus the `typeName`
// discriminator a real TLShape carries (TLShapePartial omits it). No live Editor.
const roundTrip = (s: CanvasShape, bindings?: ArrowBindingsView): CanvasShape | null => {
  const p = toTldrawPartial(s, identityEncoder);
  if (!p) return null;
  const synth = { ...(p as unknown as Record<string, unknown>), typeName: 'shape' } as unknown as TLShape;
  return fromTldrawShape(synth, {
    plaintext: (s as { text?: string }).text ?? '',
    arrowBindings: s.type === 'arrow' ? (bindings ?? {}) : undefined,
    // The pixels travel out-of-band via the asset record, not through the partial,
    // so the shell re-supplies src on the way back; simulate that here.
    imageSrc: s.type === 'image' ? s.src : undefined,
  });
};

describe('round-trip invariant: toTldrawPartial -> fromTldrawShape', () => {
  const cases: CanvasShape[] = [
    { id: 'shape:rt', type: 'rectangle', x: 5, y: 6, w: 30, h: 40, color: 'blue', text: 'hi' },
    { id: 'shape:el', type: 'ellipse', x: 1, y: 2, w: 10, h: 20, color: 'green', text: 'round' },
    { id: 'shape:tx', type: 'text', x: 7, y: 8, color: 'red', text: 'yo' },
    { id: 'shape:nt', type: 'note', x: 9, y: 10, color: 'yellow', text: 'pin' },
    { id: 'shape:ar', type: 'arrow', x1: 11, y1: 12, x2: 13, y2: 14, color: 'orange', text: 'edge' },
    // `component` carries no color through the partial (toTldrawPartial omits it),
    // so it decodes back as the 'black' default; a black representative keeps the
    // round-trip exact rather than asserting a field the seam intentionally loses.
    { id: 'shape:cm', type: 'component', x: 2, y: 3, w: 360, h: 260, module: 'KpiCard', data: { v: 1 }, rev: 4, color: 'black' },
    // `image` also omits color through the partial (decodes back to 'black'); src is
    // re-supplied by the shell via ctx.imageSrc, simulated in roundTrip().
    { id: 'shape:im', type: 'image', x: 4, y: 5, w: 120, h: 80, src: 'data:image/png;base64,AAAA', alt: 'a shot', color: 'black' },
  ];

  for (const s of cases) {
    test(`${s.type} survives the round-trip (canon equal)`, () => {
      const back = roundTrip(s);
      expect(back).not.toBeNull();
      expect(canon(back as CanvasShape)).toBe(canon(s));
    });
  }

  test('draw is excluded: toTldrawPartial returns null, so it never round-trips', () => {
    const draw: CanvasShape = { id: 'shape:dw', type: 'draw', color: 'black', points: [[0, 0], [1, 1]] };
    expect(toTldrawPartial(draw, identityEncoder)).toBeNull();
  });

  test('bound-arrow start: the round-trip preserves the {0,0} terminal placeholder', () => {
    const s: CanvasShape = { id: 'shape:ab', type: 'arrow', x1: 50, y1: 60, x2: 70, y2: 80, color: 'red', text: 'bound' };
    const back = roundTrip(s, { start: { toId: 'shape:anchor' } }) as { x1: number; y1: number; x2: number; y2: number };
    expect(back.x1).toBe(0);
    expect(back.y1).toBe(0);
    // the still-unbound end terminal round-trips to its original page coords
    expect(back.x2).toBe(70);
    expect(back.y2).toBe(80);
  });
});

describe('canon', () => {
  test('is order-independent across permuted key insertion order', () => {
    // Same shape, but the second object inserts its keys in a different order.
    const a: CanvasShape = { id: 'shape:1', type: 'rectangle', x: 1, y: 2, w: 3, h: 4, color: 'blue', text: 'hi' };
    const b = { text: 'hi', color: 'blue', h: 4, w: 3, y: 2, x: 1, type: 'rectangle', id: 'shape:1' } as CanvasShape;
    expect(canon(a)).toBe(canon(b));
  });
});
