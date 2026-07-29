// Turn loose shape input (from the agent's tool calls or an HTTP POST) into a
// validated CanvasShape, filling sensible defaults and minting an id when absent.
// Throws with an agent-legible message on bad input so the model can self-correct.

import { type CanvasShape, type ShapeColor, SHAPE_SIZE_DEFAULTS, isColor } from './shapes';
import { DataSourceSchema, type DataSource } from '../shared/mart-contract';

/**
 * Mint a tldraw-compatible shape id: a readable prefix for provenance, then 64 random
 * bits. Not for seeds — runtime uniqueness only.
 *
 * RANDOM, not sequential (#327). A counter is only unique within one process, so two
 * containers writing the same canvas both mint the same next id and the second flush
 * upserts over the first: no error, the agent reports success, a shape is gone. #324
 * primed the counter from room state, which closed the cold-container case but not this
 * one — priming cannot help when both writers prime from the same snapshot. Randomness is
 * unique without any coordination between writers, which is the only property that makes
 * the collision impossible rather than unlikely.
 *
 * Ids already on real canvases (`shape:agent_217`) are NOT rewritten — they are opaque
 * strings to everything that reads them, and they keep working unchanged.
 */
export function mintId(prefix = 'agent'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `shape:${prefix}_${suffix}`;
}

function num(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`"${field}" must be a finite number, got ${JSON.stringify(v)}`);
  }
  return n;
}

function color(v: unknown): ShapeColor {
  if (v == null) return 'black';
  if (!isColor(v)) throw new Error(`"color" must be one of black|grey|blue|green|red|orange|yellow|violet, got ${JSON.stringify(v)}`);
  return v;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** A safe component module name: letters/digits/_/-, no path separators or dots. */
function moduleName(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(v)) {
    throw new Error(`"module" must be a component name like "KpiCard" (letters/digits/_/-, no extension or path), got ${JSON.stringify(v)}`);
  }
  return v;
}

function dataObject(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('"data" must be a JSON object of props');
  return v as Record<string, unknown>;
}

/** A component's mart reference (#239 / ADR-0017: names a mart, never a URL). Absent
 * stays absent (backward compatible); present must parse against the shared contract. */
function dataSourceOf(v: unknown): DataSource | undefined {
  if (v == null) return undefined;
  return DataSourceSchema.parse(v);
}

/** A shape parented to a frame carries the frame's `shape:` id; anything else is dropped. */
export function parseParentId(raw: Record<string, unknown>): string | undefined {
  return typeof raw.parentId === 'string' && raw.parentId.startsWith('shape:') ? raw.parentId : undefined;
}

/**
 * The page a shape lives on, when it isn't the canvas's only one.
 *
 * Separate from `parentId` on purpose: `parentId` means "inside this frame" and carries a
 * coordinate contract (x/y are parent-relative), which a page has no equivalent of. A
 * shape can have both — a frame parents it, and the frame sits on a page.
 *
 * Accepts either spelling because the two ends speak differently: the agent sends `page`,
 * while a tldraw record spells a top-level shape's page as its `parentId`.
 */
export function parsePage(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.page === 'string' && raw.page.length > 0) return raw.page;
  return typeof raw.parentId === 'string' && raw.parentId.startsWith('page:') ? raw.parentId : undefined;
}

/**
 * Validate + normalize a raw shape. `id` is preserved if given (so the agent can
 * update an existing shape) else minted.
 */
export function normalizeShape(raw: Record<string, unknown>): CanvasShape {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : mintId();
  const parentId = parseParentId(raw);
  const page = parsePage(raw);
  const shape = buildShape(raw, id, color(raw.color));
  if (parentId) shape.parentId = parentId;
  if (page) shape.page = page;
  return shape;
}

function buildShape(raw: Record<string, unknown>, id: string, c: ShapeColor): CanvasShape {
  const type = raw.type;

  switch (type) {
    case 'rectangle':
    case 'ellipse':
      return {
        id,
        type,
        color: c,
        x: num(raw.x, 'x'),
        y: num(raw.y, 'y'),
        w: num(raw.w ?? SHAPE_SIZE_DEFAULTS[type].w, 'w'),
        h: num(raw.h ?? SHAPE_SIZE_DEFAULTS[type].h, 'h'),
        text: str(raw.text),
      };
    case 'text':
    case 'note':
      return {
        id,
        type,
        color: c,
        x: num(raw.x, 'x'),
        y: num(raw.y, 'y'),
        text: str(raw.text),
      };
    case 'arrow': {
      // Arrow terminals are absolute page coordinates here. `arrowTerminal` in
      // tldraw-conventions.ts is the source-of-truth inverse convention: it
      // resolves a tldraw arrow's terminals back to these page coords, collapsing
      // a bound terminal to the {0,0} placeholder.
      const startBound = typeof raw.startShapeId === 'string' && raw.startShapeId.length > 0;
      const endBound = typeof raw.endShapeId === 'string' && raw.endShapeId.length > 0;
      return {
        id,
        type,
        color: c,
        // A bound terminal's coordinates are a placeholder (the binding positions
        // it), so they default to 0 instead of being required.
        x1: startBound ? num(raw.x1 ?? 0, 'x1') : num(raw.x1, 'x1'),
        y1: startBound ? num(raw.y1 ?? 0, 'y1') : num(raw.y1, 'y1'),
        x2: endBound ? num(raw.x2 ?? 0, 'x2') : num(raw.x2, 'x2'),
        y2: endBound ? num(raw.y2 ?? 0, 'y2') : num(raw.y2, 'y2'),
        text: str(raw.text),
        ...(startBound ? { startShapeId: raw.startShapeId as string } : {}),
        ...(endBound ? { endShapeId: raw.endShapeId as string } : {}),
      };
    }
    case 'component':
      return {
        id,
        type,
        color: c,
        x: num(raw.x, 'x'),
        y: num(raw.y, 'y'),
        w: num(raw.w ?? SHAPE_SIZE_DEFAULTS.component.w, 'w'),
        h: num(raw.h ?? SHAPE_SIZE_DEFAULTS.component.h, 'h'),
        module: moduleName(raw.module),
        data: dataObject(raw.data),
        rev: raw.rev == null ? 0 : num(raw.rev, 'rev'),
        ...(raw.dataSource != null ? { dataSource: dataSourceOf(raw.dataSource) } : {}),
      };
    case 'chat':
      return {
        id,
        type,
        color: c,
        x: num(raw.x, 'x'),
        y: num(raw.y, 'y'),
        w: num(raw.w ?? SHAPE_SIZE_DEFAULTS.chat.w, 'w'),
        h: num(raw.h ?? SHAPE_SIZE_DEFAULTS.chat.h, 'h'),
        title: str(raw.title) || 'Chat',
        // Attach flow: the card fronts an existing chat. Absent/'' stays absent.
        ...(str(raw.chatId) ? { chatId: str(raw.chatId) } : {}),
      };
    case 'frame':
      return {
        id,
        type,
        color: c,
        x: num(raw.x, 'x'),
        y: num(raw.y, 'y'),
        w: num(raw.w ?? SHAPE_SIZE_DEFAULTS.frame.w, 'w'),
        h: num(raw.h ?? SHAPE_SIZE_DEFAULTS.frame.h, 'h'),
        name: str(raw.name),
      };
    case 'draw':
      throw new Error('"draw" (freehand) shapes are human-only and cannot be created via the API');
    case 'image':
      throw new Error('"image" shapes are added by the human (paste/drop); the agent cannot create one (no pixels to supply)');
    default:
      throw new Error(`unknown shape type ${JSON.stringify(type)}; expected rectangle|ellipse|text|note|arrow|component|chat|frame`);
  }
}

/**
 * Validate a shape coming FROM the browser (the human's edits). Same as
 * normalizeShape but also accepts freehand `draw` strokes, which only humans
 * author. Ids are always preserved here (they are real tldraw shape ids).
 */
export function normalizeIncomingShape(raw: Record<string, unknown>): CanvasShape {
  if (raw.type === 'draw') {
    if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('draw shape requires an id');
    const pts = raw.points;
    if (!Array.isArray(pts)) throw new Error('draw shape requires a points array');
    const points = pts.map((p, i) => {
      if (!Array.isArray(p) || p.length < 2) throw new Error(`points[${i}] must be [x, y]`);
      return [num(p[0], `points[${i}][0]`), num(p[1], `points[${i}][1]`)] as [number, number];
    });
    return { id: raw.id, type: 'draw', color: color(raw.color), points };
  }
  if (raw.type === 'image') {
    // Human-authored only (paste/drop): keep the real tldraw shape id and the
    // `src` data URL. A missing src is tolerated (the asset can lag the shape by a
    // tick) — the node still appears; read_image just has nothing to show yet.
    if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('image shape requires an id');
    const parentId = parseParentId(raw);
    const shape: CanvasShape = {
      id: raw.id,
      type: 'image',
      color: color(raw.color),
      x: num(raw.x, 'x'),
      y: num(raw.y, 'y'),
      w: num(raw.w ?? SHAPE_SIZE_DEFAULTS.image.w, 'w'),
      h: num(raw.h ?? SHAPE_SIZE_DEFAULTS.image.h, 'h'),
      src: str(raw.src),
      alt: str(raw.alt),
    };
    if (parentId) shape.parentId = parentId;
    const page = parsePage(raw);
    if (page) shape.page = page;
    return shape;
  }
  if (raw.type === 'embed') {
    // Human-authored only (paste a YouTube/embed URL): keep the real tldraw shape
    // id and the embed url. The agent has no embed-authoring tool, so embeds only
    // ever enter through this browser path.
    if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('embed shape requires an id');
    const parentId = parseParentId(raw);
    const shape: CanvasShape = {
      id: raw.id,
      type: 'embed',
      color: color(raw.color),
      x: num(raw.x, 'x'),
      y: num(raw.y, 'y'),
      w: num(raw.w ?? SHAPE_SIZE_DEFAULTS.embed.w, 'w'),
      h: num(raw.h ?? SHAPE_SIZE_DEFAULTS.embed.h, 'h'),
      url: str(raw.url),
    };
    if (parentId) shape.parentId = parentId;
    const page = parsePage(raw);
    if (page) shape.page = page;
    return shape;
  }
  return normalizeShape(raw);
}
