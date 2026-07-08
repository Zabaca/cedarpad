// The simplified canvas shape model — the single source of truth shared by the
// bridge server, the browser sync layer, and the agent tools. Deliberately
// smaller than tldraw's internal record model: this is what an agent reads and
// writes, so it stays human/LLM-legible. Translation to/from real tldraw shapes
// lives only in the browser (src/sync.ts).

export const SHAPE_COLORS = [
  'black',
  'grey',
  'blue',
  'green',
  'red',
  'orange',
  'yellow',
  'violet',
] as const;

export type ShapeColor = (typeof SHAPE_COLORS)[number];

export interface BaseShape {
  /** Canonical id, shared verbatim with the tldraw shape id. e.g. "shape:abc". */
  id: string;
  color: ShapeColor;
  /**
   * Containing frame's shape id, set only when this shape is a child of a `frame`.
   * Omitted for top-level (page-parented) shapes. When present, the shape's x/y are
   * parent-relative (tldraw's native representation), so the frame and its children
   * round-trip without coordinate math — the frame just has to be created first.
   */
  parentId?: string;
}

export interface RectangleShape extends BaseShape {
  type: 'rectangle';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface EllipseShape extends BaseShape {
  type: 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface TextShape extends BaseShape {
  type: 'text';
  x: number;
  y: number;
  text: string;
}

export interface NoteShape extends BaseShape {
  type: 'note';
  x: number;
  y: number;
  text: string;
}

export interface ArrowShape extends BaseShape {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text: string;
  // Optional shape bindings. When set, that terminal snaps to the shape and
  // follows it when the shape moves; the x/y for that terminal become a 0,0
  // placeholder (the binding controls the rendered position). Free terminals
  // keep their coordinates.
  startShapeId?: string;
  endShapeId?: string;
}

/** Freehand pen strokes. Read-only for agents: humans draw these, agents see them. */
export interface DrawShape extends BaseShape {
  type: 'draw';
  points: Array<[number, number]>;
}

/**
 * A live custom component: an instance of a real React module the agent authored
 * as a file under `src/canvas-components/`. The shape references the module by
 * name (not its source) and passes `data` as props; vite compiles the file and
 * the `component` ShapeUtil dynamic-imports it. `rev` bumps when the agent edits
 * the file, forcing a fresh re-import. Components import each other + data freely.
 */
/**
 * A `component` instance's load/render lifecycle. The host mirrors it onto the
 * tldraw shape's `meta`, and the read bridge lifts it onto this model field so the
 * agent can observe (via read_canvas) whether a placed component actually came up.
 * `loading`/`ready` track the load; `load_error` is written when the load exhausts
 * the loader's retry budget, `render_error` when the rendered component throws.
 */
export type ComponentStatus =
  | { phase: 'loading'; attempt: number }
  | { phase: 'ready' }
  | { phase: 'load_error'; message: string; attempts: number }
  | { phase: 'render_error'; message: string; where: string };

export interface ComponentShape extends BaseShape {
  type: 'component';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Module name under src/canvas-components/, without extension (e.g. "KpiCard"). */
  module: string;
  /** Props passed to the component (the data channel). */
  data: Record<string, unknown>;
  /** Reload token; bumped on edit so the browser re-imports the recompiled module. */
  rev: number;
  /**
   * The component's load/render lifecycle, lifted from the host's tldraw `meta` by
   * the read bridge so read_canvas exposes it to the agent. OPTIONAL: a shape that
   * never mounted, or a doc from before this field, reads back `undefined`.
   */
  status?: ComponentStatus;
}

/**
 * A chat session living on the canvas. The shape id IS the chat id (used in
 * /api/chat/<id>/{stream,send}); the transcript is derived server-side from the SDK
 * session JSONL and the resume token + config live in the server-owned ChatMeta keyed
 * by that id (ADR 0004), not in the browser. Human-only: created by the "New chat"
 * control, not by the agent.
 */
export interface ChatShape extends BaseShape {
  type: 'chat';
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

/**
 * A bitmap image on the canvas (a pasted/dropped screenshot or photo). Built-in
 * tldraw shape, human-authored only (the agent can't create one — it has no
 * pixels to supply). The pixels live in `src` as a data URL; tldraw stores them
 * in a separate asset record, which the sync layer creates from `src` on the way
 * in. `src` is deliberately REDACTED from read_canvas/read_connected (a data URL
 * is huge); the agent looks at the actual image via the read_image tool.
 */
export interface ImageShape extends BaseShape {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Image data URL, e.g. "data:image/png;base64,....". */
  src: string;
  /** Alt text / description, if any. */
  alt: string;
}

/**
 * A tldraw frame: a named, sized container. Shapes dropped inside become its
 * children (their `parentId` points here, coords parent-relative), so moving the
 * frame moves its contents. Human-authored via the frame tool. Built-in tldraw
 * shape (not custom), so it round-trips as type `frame`.
 */
export interface FrameShape extends BaseShape {
  type: 'frame';
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

/**
 * A tldraw embed shape (e.g. a YouTube video pasted as a URL). Human-authored
 * only — the agent can read and persist these but doesn't create them.
 */
export interface EmbedShape extends BaseShape {
  type: 'embed';
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

export type CanvasShape =
  | RectangleShape
  | EllipseShape
  | TextShape
  | NoteShape
  | ArrowShape
  | DrawShape
  | ComponentShape
  | ChatShape
  | ImageShape
  | FrameShape
  | EmbedShape;

export type ShapeType = CanvasShape['type'];

/** Types an agent is allowed to author. Freehand `draw` is human-only. */
export const AGENT_DRAWABLE_TYPES = ['rectangle', 'ellipse', 'text', 'note', 'arrow', 'component'] as const;

export interface CanvasState {
  /** Monotonic counter, bumped on every mutation. Drives client reconciliation. */
  version: number;
  shapes: CanvasShape[];
}

export const isColor = (v: unknown): v is ShapeColor =>
  typeof v === 'string' && (SHAPE_COLORS as readonly string[]).includes(v);
