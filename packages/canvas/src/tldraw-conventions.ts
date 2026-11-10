// Pure translation conventions between the simplified CanvasShape model and real
// tldraw shapes — the subset of the bridge's rules that do NOT need a live Editor
// or the DOM. This module is the DOM-free home for those rules so they can be
// unit-tested in plain Node (no browser).
//
// Hard constraint: any tldraw import here MUST be `type`-only (e.g.
// `import type { TLShapePartial } from 'tldraw'`). Pulling in tldraw's runtime
// drags in the DOM and breaks loading under a Node test runner. Both directions
// take their Editor-coupled inputs as parameters for exactly this reason:
// `toTldrawPartial` is handed an `encodeText` (the browser-coupled `toRichText`
// stays in the shell), and `fromTldrawShape` is handed already-decoded
// `plaintext` + resolved `arrowBindings` (the shell does the `Editor` calls).

import type { TLShape, TLShapePartial, TLShapeId } from 'tldraw';

import { SHAPE_COLORS, SHAPE_SIZE_DEFAULTS } from './shapes';
import type { CanvasShape, ComponentStatus, ShapeColor } from './shapes';

const KNOWN = new Set<string>(SHAPE_COLORS);
const LIGHT_MAP: Record<string, ShapeColor> = {
  'light-blue': 'blue',
  'light-green': 'green',
  'light-red': 'red',
  'light-violet': 'violet',
  white: 'grey',
};

/** Clamp any tldraw color onto our 8-color palette. */
export function clampColor(c: unknown): ShapeColor {
  if (typeof c === 'string') {
    if (KNOWN.has(c)) return c as ShapeColor;
    if (LIGHT_MAP[c]) return LIGHT_MAP[c];
  }
  return 'black';
}

/**
 * Deterministic asset id for an image shape. We control both sides of the bridge,
 * so rather than carry tldraw's original asset id through the model we derive one
 * from the shape id: the sync layer creates the matching asset record from the
 * shape's `src` when recreating the image (on another client or after a reload).
 */
export const imageAssetId = (shapeId: string): string => `asset:${shapeId.replace(/^shape:/, '')}`;

type Point = { x: number; y: number };

/**
 * Resolve an arrow terminal's page coordinates. A *bound* terminal (anchored to
 * another shape) has no fixed point, so it collapses to the `{0,0}` placeholder
 * convention; an unbound terminal is the shape origin plus its local offset. This
 * is the single source of truth for that convention.
 */
export function arrowTerminal(shapeXY: Point, local: Point, bound: boolean): Point {
  if (bound) return { x: 0, y: 0 };
  return { x: shapeXY.x + local.x, y: shapeXY.y + local.y };
}

/**
 * Simplified -> tldraw shape partial, ready for createShapes/updateShapes.
 * Null = not representable (freehand `draw`, which only the local human authors).
 *
 * `encodeText` is injected so this pure module never imports tldraw's runtime
 * `toRichText` (which drags in the DOM): the browser shell passes the real
 * encoder; tests pass a plain identity. Color is clamped onto our palette via
 * `clampColor`, so an off-palette value can never reach tldraw.
 */
export function toTldrawPartial<R>(s: CanvasShape, encodeText: (plain: string) => R): TLShapePartial | null {
  const partial = buildPartial(s, encodeText);
  // A shape's tldraw parent is its frame if it has one (recreated inside the frame,
  // coords already parent-relative — the frame must exist first, which the sync layer
  // orders). A top-level shape has none, and tldraw parents it to the canvas itself.
  if (partial && s.parentId) (partial as { parentId?: string }).parentId = s.parentId as TLShapeId;
  return partial;
}

function buildPartial<R>(s: CanvasShape, encodeText: (plain: string) => R): TLShapePartial | null {
  const id = s.id as TLShapeId;
  switch (s.type) {
    case 'rectangle':
    case 'ellipse':
      return {
        id,
        type: 'geo',
        x: s.x,
        y: s.y,
        props: { geo: s.type === 'ellipse' ? 'ellipse' : 'rectangle', w: s.w, h: s.h, color: clampColor(s.color), richText: encodeText(s.text) },
      } as unknown as TLShapePartial;
    case 'text':
      return { id, type: 'text', x: s.x, y: s.y, props: { color: clampColor(s.color), richText: encodeText(s.text) } } as unknown as TLShapePartial;
    case 'note':
      return { id, type: 'note', x: s.x, y: s.y, props: { color: clampColor(s.color), richText: encodeText(s.text) } } as unknown as TLShapePartial;
    case 'arrow':
      return {
        id,
        type: 'arrow',
        x: 0,
        y: 0,
        props: { color: clampColor(s.color), start: { x: s.x1, y: s.y1 }, end: { x: s.x2, y: s.y2 }, richText: encodeText(s.text) },
      } as unknown as TLShapePartial;
    case 'component':
      // `component` is our custom shape, not in tldraw's built-in TLShape union.
      return {
        id,
        type: 'component',
        x: s.x,
        y: s.y,
        // dataSource is a retired prop (see shape-props.ts): always written null.
        props: { w: s.w, h: s.h, module: s.module, data: s.data, rev: s.rev, dataSource: null },
      } as unknown as TLShapePartial;
    case 'chat':
      // `chat` is our custom shape (a conversation card); the shape id is the chat id —
      // unless `chatId` is set (attach flow), in which case the card fronts that chat.
      // tldraw props are total, so the absent case encodes as ''.
      return {
        id,
        type: 'chat',
        x: s.x,
        y: s.y,
        props: { w: s.w, h: s.h, title: s.title, chatId: s.chatId ?? '' },
      } as unknown as TLShapePartial;
    case 'frame':
      // Built-in tldraw container. `name` is its label; children parent to it.
      return {
        id,
        type: 'frame',
        x: s.x,
        y: s.y,
        props: { w: s.w, h: s.h, name: s.name },
      } as unknown as TLShapePartial;
    case 'image':
      // Built-in tldraw image. The pixels are in an asset record (created by the
      // sync layer from `s.src`); the shape only references it by a deterministic
      // asset id. createShapes fills the remaining image props (crop/flip/...) with
      // defaults.
      return {
        id,
        type: 'image',
        x: s.x,
        y: s.y,
        props: { w: s.w, h: s.h, assetId: imageAssetId(s.id), altText: s.alt },
      } as unknown as TLShapePartial;
    case 'draw':
      // Freehand is authored only by the local human; never recreated from the model.
      return null;
    case 'embed':
      // Embed shapes (e.g. YouTube) are human-authored; recreate from stored url.
      return {
        id,
        type: 'embed',
        x: s.x,
        y: s.y,
        props: { url: s.url, w: s.w, h: s.h },
      } as unknown as TLShapePartial;
    default: {
      // Exhaustiveness guard: a new CanvasShape variant must add a case above, or
      // this fails to compile. (A dropped `chat` case once silently broke sync.)
      const _exhaustive: never = s;
      return _exhaustive ?? null;
    }
  }
}

type AnyProps = Record<string, unknown>;
const readProps = (shape: TLShape): AnyProps => (shape as unknown as { props: AnyProps }).props;

/**
 * A read-only view of an arrow's resolved bindings — just which terminal is
 * anchored to another shape (its `toId` is present). The shell flattens tldraw's
 * real bindings (an `Editor` call) down to this so the pure decoder never touches
 * an `Editor`.
 */
export type ArrowBindingsView = { start?: { toId: string }; end?: { toId: string } };

/**
 * tldraw shape -> simplified CanvasShape. Null = a shape type the agent doesn't
 * model. Pure: the two Editor-coupled inputs are lifted to `ctx` — `plaintext`
 * (the shell decodes the shape's richText) and `arrowBindings` (the shell
 * resolves them). A bound arrow terminal collapses to the `{0,0}` placeholder via
 * `arrowTerminal`, the single source of truth for that convention; an unbound
 * terminal is the shape origin plus its local offset.
 */
export function fromTldrawShape(
  shape: TLShape,
  ctx: { plaintext: string; arrowBindings?: ArrowBindingsView; imageSrc?: string },
): CanvasShape | null {
  const out = decodeFromTldraw(shape, ctx);
  if (out) {
    // Preserve frame membership: a shape parented to another shape (a frame) keeps
    // that parent id so it round-trips back inside the frame.
    const pid = (shape as { parentId?: unknown }).parentId;
    if (typeof pid === 'string' && pid.startsWith('shape:')) out.parentId = pid;
  }
  return out;
}

function decodeFromTldraw(
  shape: TLShape,
  ctx: { plaintext: string; arrowBindings?: ArrowBindingsView; imageSrc?: string },
): CanvasShape | null {
  const p = readProps(shape);
  const color = clampColor(p.color);
  // Cast to string: our custom `component` type isn't in tldraw's built-in union,
  // and every branch below reads from `p` (AnyProps) + base fields, not narrowed
  // per-type records.
  switch (shape.type as string) {
    case 'geo': {
      const isEllipse = p.geo === 'ellipse';
      return {
        id: shape.id,
        type: isEllipse ? 'ellipse' : 'rectangle',
        x: shape.x,
        y: shape.y,
        w: Number(p.w ?? SHAPE_SIZE_DEFAULTS.rectangle.w),
        h: Number(p.h ?? SHAPE_SIZE_DEFAULTS.rectangle.h),
        color,
        text: ctx.plaintext,
      };
    }
    case 'text':
      return { id: shape.id, type: 'text', x: shape.x, y: shape.y, color, text: ctx.plaintext };
    case 'note':
      return { id: shape.id, type: 'note', x: shape.x, y: shape.y, color, text: ctx.plaintext };
    case 'arrow': {
      const startLocal = (p.start ?? { x: 0, y: 0 }) as { x: number; y: number };
      const endLocal = (p.end ?? { x: 0, y: 0 }) as { x: number; y: number };
      const origin = { x: shape.x, y: shape.y };
      const startToId = ctx.arrowBindings?.start?.toId;
      const endToId = ctx.arrowBindings?.end?.toId;
      const start = arrowTerminal(origin, startLocal, !!startToId);
      const end = arrowTerminal(origin, endLocal, !!endToId);
      // A bound terminal carries the target shape id so sync.ts can reconcile the
      // tldraw binding (snap-to-shape, follow-on-move). Without it a bound arrow
      // would lose its binding on the next read/sync.
      return {
        id: shape.id,
        type: 'arrow',
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        color,
        text: ctx.plaintext,
        ...(startToId ? { startShapeId: startToId } : {}),
        ...(endToId ? { endShapeId: endToId } : {}),
      };
    }
    case 'component':
      return {
        id: shape.id,
        type: 'component',
        x: shape.x,
        y: shape.y,
        w: Number(p.w ?? SHAPE_SIZE_DEFAULTS.component.w),
        h: Number(p.h ?? SHAPE_SIZE_DEFAULTS.component.h),
        module: String(p.module ?? 'Missing'),
        data: (p.data ?? {}) as Record<string, unknown>,
        rev: Number(p.rev ?? 0),
        color,
        // Lift the host-written load/render lifecycle off tldraw `meta` onto the
        // model so read_canvas exposes it — without this the agent never sees that
        // a component it placed failed to load. Absent on a never-mounted/legacy shape.
        ...(shape.meta?.status ? { status: shape.meta.status as ComponentStatus } : {}),
      };
    case 'chat':
      return {
        id: shape.id,
        type: 'chat',
        x: shape.x,
        y: shape.y,
        w: Number(p.w ?? SHAPE_SIZE_DEFAULTS.chat.w),
        h: Number(p.h ?? SHAPE_SIZE_DEFAULTS.chat.h),
        title: String(p.title ?? 'Chat'),
        // '' is the tldraw-props encoding of "no override" — drop it so the model stays
        // byte-stable with pre-chatId docs and canvas-born cards.
        ...(p.chatId ? { chatId: String(p.chatId) } : {}),
        color,
      };
    case 'frame':
      return {
        id: shape.id,
        type: 'frame',
        x: shape.x,
        y: shape.y,
        w: Number(p.w ?? SHAPE_SIZE_DEFAULTS.frame.w),
        h: Number(p.h ?? SHAPE_SIZE_DEFAULTS.frame.h),
        name: String(p.name ?? ''),
        color,
      };
    case 'image':
      // `src` is resolved by the shell (editor.getAsset on the shape's assetId) and
      // passed in via ctx, since the pixels live in an asset record, not the shape.
      return {
        id: shape.id,
        type: 'image',
        x: shape.x,
        y: shape.y,
        w: Number(p.w ?? SHAPE_SIZE_DEFAULTS.image.w),
        h: Number(p.h ?? SHAPE_SIZE_DEFAULTS.image.h),
        src: ctx.imageSrc ?? '',
        alt: String(p.altText ?? ''),
        color,
      };
    case 'draw': {
      const segments = (p.segments ?? []) as Array<{ points: Array<{ x: number; y: number }> }>;
      const points: Array<[number, number]> = [];
      for (const seg of segments) for (const pt of seg.points) points.push([shape.x + pt.x, shape.y + pt.y]);
      return { id: shape.id, type: 'draw', color, points };
    }
    case 'embed':
      return {
        id: shape.id,
        type: 'embed',
        x: shape.x,
        y: shape.y,
        w: Number(p.w ?? SHAPE_SIZE_DEFAULTS.embed.w),
        h: Number(p.h ?? SHAPE_SIZE_DEFAULTS.embed.h),
        url: String(p.url ?? ''),
        color,
      };
    default:
      return null;
  }
}

/** Stable, key-order-independent serialization for change detection. */
export const canon = (s: CanvasShape): string =>
  JSON.stringify(Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))));
