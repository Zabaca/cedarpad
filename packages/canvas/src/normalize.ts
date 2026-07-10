// Turn loose shape input (from the agent's tool calls or an HTTP POST) into a
// validated CanvasShape, filling sensible defaults and minting an id when absent.
// Throws with an agent-legible message on bad input so the model can self-correct.

import { type CanvasShape, type ShapeColor, isColor } from './shapes';

let counter = 0;
/** Mint a tldraw-compatible shape id. Not for seeds — runtime uniqueness only. */
export function mintId(prefix = 'agent'): string {
  counter += 1;
  return `shape:${prefix}_${counter}`;
}

/**
 * Advance the mint counter past any `shape:<prefix>_<n>` ids already present (e.g.
 * after loading persisted shapes), so freshly minted ids never collide with them.
 */
export function primeIdCounter(existingIds: Iterable<string>): void {
  for (const id of existingIds) {
    const m = /_(\d+)$/.exec(id);
    if (m) counter = Math.max(counter, Number(m[1]));
  }
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

/**
 * Validate + normalize a raw shape. `id` is preserved if given (so the agent can
 * update an existing shape) else minted.
 */
export function normalizeShape(raw: Record<string, unknown>): CanvasShape {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : mintId();
  // A shape parented to a frame carries the frame's shape id.
  const parentId = typeof raw.parentId === 'string' && raw.parentId.startsWith('shape:') ? raw.parentId : undefined;
  const shape = buildShape(raw, id, color(raw.color));
  if (parentId) shape.parentId = parentId;
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
        w: num(raw.w ?? 160, 'w'),
        h: num(raw.h ?? 100, 'h'),
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
        w: num(raw.w ?? 360, 'w'),
        h: num(raw.h ?? 260, 'h'),
        module: moduleName(raw.module),
        data: dataObject(raw.data),
        rev: raw.rev == null ? 0 : num(raw.rev, 'rev'),
      };
    case 'chat':
      return {
        id,
        type,
        color: c,
        x: num(raw.x, 'x'),
        y: num(raw.y, 'y'),
        w: num(raw.w ?? 380, 'w'),
        h: num(raw.h ?? 460, 'h'),
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
        w: num(raw.w ?? 320, 'w'),
        h: num(raw.h ?? 240, 'h'),
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
    const parentId = typeof raw.parentId === 'string' && raw.parentId.startsWith('shape:') ? raw.parentId : undefined;
    const shape: CanvasShape = {
      id: raw.id,
      type: 'image',
      color: color(raw.color),
      x: num(raw.x, 'x'),
      y: num(raw.y, 'y'),
      w: num(raw.w ?? 100, 'w'),
      h: num(raw.h ?? 100, 'h'),
      src: str(raw.src),
      alt: str(raw.alt),
    };
    if (parentId) shape.parentId = parentId;
    return shape;
  }
  if (raw.type === 'embed') {
    // Human-authored only (paste a YouTube/embed URL): keep the real tldraw shape
    // id and the embed url. The agent has no embed-authoring tool, so embeds only
    // ever enter through this browser path.
    if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('embed shape requires an id');
    const parentId = typeof raw.parentId === 'string' && raw.parentId.startsWith('shape:') ? raw.parentId : undefined;
    const shape: CanvasShape = {
      id: raw.id,
      type: 'embed',
      color: color(raw.color),
      x: num(raw.x, 'x'),
      y: num(raw.y, 'y'),
      w: num(raw.w ?? 480, 'w'),
      h: num(raw.h ?? 270, 'h'),
      url: str(raw.url),
    };
    if (parentId) shape.parentId = parentId;
    return shape;
  }
  return normalizeShape(raw);
}
