// Pure canvas operations over a CanvasStore. These are what the agent's tools
// call, but they have no dependency on the agent SDK, so they're unit-testable
// directly. Each returns an agent-legible result string (and an error flag).

import type { ArrowShape, CanvasShape } from './shapes';
import type { CanvasStore } from './store';
import { normalizeShape } from './normalize';
import type { DataSource } from '../shared/mart-contract';

export interface OpResult {
  text: string;
  isError?: boolean;
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bounds(s: CanvasShape): Box | null {
  switch (s.type) {
    case 'rectangle':
    case 'ellipse':
    case 'component':
    case 'chat':
    case 'image':
    case 'frame':
      return { minX: s.x, minY: s.y, maxX: s.x + s.w, maxY: s.y + s.h };
    case 'text':
    case 'note':
      return { minX: s.x, minY: s.y, maxX: s.x, maxY: s.y };
    case 'arrow':
      return { minX: Math.min(s.x1, s.x2), minY: Math.min(s.y1, s.y2), maxX: Math.max(s.x1, s.x2), maxY: Math.max(s.y1, s.y2) };
    default:
      return null;
  }
}

function moveTo(s: CanvasShape, x: number, y: number): CanvasShape {
  if (s.type === 'arrow') {
    const dx = x - Math.min(s.x1, s.x2);
    const dy = y - Math.min(s.y1, s.y2);
    return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  }
  if (s.type === 'draw') return s; // not movable via ops
  return { ...s, x, y };
}

/** Shift a shape by (dx, dy), preserving its size and an arrow's internal vector. */
function shift(s: CanvasShape, dx: number, dy: number): CanvasShape {
  if (s.type === 'arrow') return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  if (s.type === 'draw') return s;
  return { ...s, x: s.x + dx, y: s.y + dy };
}

const rectsOverlap = (a: Box, b: Box): boolean =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

const TUCK_GAP = 60;

/**
 * Reposition a fresh batch into free space just to the LEFT of the originating chat,
 * preserving the batch's internal layout. POSITION ONLY: root-linking is the
 * {@link attachBatchToChat} seam's job (it is the sole caller), so this returns just
 * the repositioned batch. If the chat isn't on the canvas (older client, cleared),
 * returns the batch unchanged.
 */
function tuckBesideChat(store: CanvasStore, made: CanvasShape[], chatId: string): CanvasShape[] {
  const chat = store.getState().shapes.find((s) => s.id === chatId);
  const cb = chat && bounds(chat);
  if (!cb) return made;

  // Box of the placeable, non-arrow shapes in the batch (bound arrows carry a
  // {0,0} placeholder that would skew the box; free arrows ride along on the shift).
  const placeableBoxes = made.filter((s) => s.type !== 'arrow').map(bounds).filter((b): b is Box => b !== null);
  if (placeableBoxes.length > 0) {
    const bx = {
      minX: Math.min(...placeableBoxes.map((b) => b.minX)),
      minY: Math.min(...placeableBoxes.map((b) => b.minY)),
      maxX: Math.max(...placeableBoxes.map((b) => b.maxX)),
      maxY: Math.max(...placeableBoxes.map((b) => b.maxY)),
    };
    const w = bx.maxX - bx.minX;
    const h = bx.maxY - bx.minY;

    // Find the NEAREST free slot beside the chat, searching BOTH axes (not just
    // marching down): candidates fan out in columns to the left of the chat and rows
    // below its top; we pick the closest one that doesn't overlap existing content. A
    // busy left column therefore wraps into the next column over instead of flinging
    // the shape thousands of px down (the old y-only march).
    const others = store
      .getState()
      .shapes.filter((s) => s.id !== chatId)
      .map(bounds)
      .filter((b): b is Box => b !== null);
    const free = (x: number, y: number) => !others.some((o) => rectsOverlap({ minX: x, minY: y, maxX: x + w, maxY: y + h }, o));
    const baseX = cb.minX - TUCK_GAP - w; // immediately left of the chat
    const candidates: Array<{ x: number; y: number }> = [];
    for (let col = 0; col < 8; col += 1) {
      for (let row = 0; row < 8; row += 1) {
        candidates.push({ x: baseX - col * (w + TUCK_GAP), y: cb.minY + row * (h + TUCK_GAP) });
      }
    }
    candidates.sort((a, b) => Math.hypot(a.x - cb.minX, a.y - cb.minY) - Math.hypot(b.x - cb.minX, b.y - cb.minY));
    const slot = candidates.find((c) => free(c.x, c.y)) ?? { x: baseX, y: cb.minY };

    const dx = slot.x - bx.minX;
    const dy = slot.y - bx.minY;
    made = made.map((s) => shift(s, dx, dy));
  }

  return made;
}

/**
 * Link arrows from `chatId` to each "root" of the batch — a new non-arrow shape the
 * batch didn't itself point an arrow at. So a single shape gets one arrow from the
 * chat; a flowchart is linked at its entry nodes, not spammed with an arrow per node.
 * Pure + positioning-free; the {@link attachBatchToChat} seam is its sole caller (it
 * links after the position policy resolves, whether the batch was tucked or kept as-is).
 */
function linkRootsToChat(made: CanvasShape[], chatId: string): CanvasShape[] {
  const targeted = new Set(made.filter((s) => s.type === 'arrow').map((s) => s.endShapeId).filter(Boolean) as string[]);
  return made
    .filter((s) => s.type !== 'arrow' && s.type !== 'draw' && !targeted.has(s.id))
    .map((s) => normalizeShape({ type: 'arrow', color: 'grey', startShapeId: chatId, endShapeId: s.id }));
}

// An image's `src` is a (potentially huge) data URL; never dump it into the
// agent's context. Replace it with a marker pointing at read_image, leaving the
// rest of the image's state (geometry, alt) intact. All other shapes pass through.
function redactForRead(s: CanvasShape): CanvasShape | Record<string, unknown> {
  if (s.type !== 'image') return s;
  const { src, ...rest } = s;
  return { ...rest, src: `<image data (~${Math.round(src.length / 1024)}KB); call read_image("${s.id}") to view>` };
}

export function readOp(store: CanvasStore): OpResult {
  const shapes = store.getState().shapes;
  if (shapes.length === 0) return { text: 'The canvas is empty.' };
  return { text: `${shapes.length} shape(s):\n${JSON.stringify(shapes.map(redactForRead), null, 2)}` };
}

/** The data URL of an image shape, or null if not an image / not found / no pixels. */
export function imageSrcOf(store: CanvasStore, id: string): string | null {
  const s = store.getState().shapes.find((x) => x.id === id);
  return s && s.type === 'image' && s.src ? s.src : null;
}

/** How a freshly attached batch is positioned: tuck it, or honor the agent's coords. */
export interface AttachOptions {
  /** true = leave shape coords as-given; false = tuck the batch beside the chat. */
  preservePosition: boolean;
}

/**
 * Attach a fresh batch of shapes to its originating chat — the single owner of the
 * two concerns callers used to scatter: position policy and root linking, behind one
 * chat-missing guard.
 *
 * Orchestrates the existing composable internals (it inlines none of them):
 * - Position: `preservePosition: false` tucks the batch via {@link tuckBesideChat};
 *   `true` keeps the agent's coords. Position policy only.
 * - Root linking: either way the batch then gains one arrow per "root" (a non-arrow,
 *   non-draw shape no arrow in the batch points at) via {@link linkRootsToChat}.
 *
 * If the chat id resolves to nothing on the canvas, the batch is returned unchanged:
 * no arrows.
 */
export function attachBatchToChat(
  store: CanvasStore,
  made: CanvasShape[],
  chatId: string,
  opts: AttachOptions,
): CanvasShape[] {
  if (!store.getState().shapes.some((s) => s.id === chatId)) return made;
  const positioned = opts.preservePosition ? made : tuckBesideChat(store, made, chatId);
  return [...positioned, ...linkRootsToChat(positioned, chatId)];
}

export function createShapesOp(store: CanvasStore, raw: Array<Record<string, unknown>>, originChatId?: string): OpResult {
  try {
    const made = raw.map((r) => normalizeShape({ ...r, id: undefined }));
    const toUpsert = originChatId
      ? attachBatchToChat(store, made, originChatId, { preservePosition: false })
      : made;
    store.upsert(toUpsert);
    const linked = originChatId ? ' (placed beside the chat and linked with an arrow)' : '';
    return { text: `Created ${made.length} shape(s): ${made.map((s) => `${s.type}#${s.id}`).join(', ')}${linked}` };
  } catch (e) {
    return { text: `Error: ${(e as Error).message}`, isError: true };
  }
}

export type GraphDirection = 'out' | 'in' | 'both';

export interface ConnectedOptions {
  depth?: number;
  direction?: GraphDirection;
}

/**
 * Read the connected subgraph around `rootId`: every shape reachable by following
 * bound arrows (the canvas's edges) up to `depth` hops, plus the edges between
 * them. This is the agent's "what am I linked to?" view — it starts from the chat
 * card by default, so the agent gets its own nodes and their FULL state (text,
 * component data, geometry, color) without dumping or parsing the whole canvas.
 *
 * Arrows are edges, not nodes; only fully-bound arrows (both terminals on a shape)
 * count. `direction` follows arrows outward (root -> ...), inward (... -> root), or
 * both (default, treats the graph as undirected — "connected to me either way").
 */
export function connectedOp(store: CanvasStore, rootId: string, opts: ConnectedOptions = {}): OpResult {
  const { depth = Number.POSITIVE_INFINITY, direction = 'both' } = opts;
  const shapes = store.getState().shapes;
  const byId = new Map(shapes.map((s) => [s.id, s]));
  if (!rootId || !byId.has(rootId)) {
    return { text: `Error: no shape with id "${rootId}" on the canvas to start from.`, isError: true };
  }

  const arrows = shapes.filter((s): s is ArrowShape => s.type === 'arrow' && !!s.startShapeId && !!s.endShapeId);
  // Adjacency: node id -> reachable node ids, per the requested direction.
  const adj = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  };
  for (const a of arrows) {
    const s = a.startShapeId!;
    const e = a.endShapeId!;
    if (direction === 'out' || direction === 'both') link(s, e);
    if (direction === 'in' || direction === 'both') link(e, s);
  }

  // BFS out to `depth` hops.
  const visited = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adj.get(id) ?? []) {
        if (!visited.has(to) && byId.has(to)) {
          visited.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }

  // Nodes = visited non-arrow shapes (full state). Edges = bound arrows whose
  // BOTH endpoints landed in the visited set.
  const nodes = [...visited].map((id) => byId.get(id)!).filter((s) => s.type !== 'arrow').map(redactForRead);
  const edges = arrows
    .filter((a) => visited.has(a.startShapeId!) && visited.has(a.endShapeId!))
    .map((a) => ({ id: a.id, from: a.startShapeId, to: a.endShapeId, ...(a.text ? { text: a.text } : {}) }));

  const graph = { root: rootId, nodes, edges };
  return { text: `Connected subgraph from ${rootId}: ${nodes.length} node(s), ${edges.length} edge(s).\n${JSON.stringify(graph, null, 2)}` };
}

export function updateShapesOp(store: CanvasStore, patches: Array<Record<string, unknown>>): OpResult {
  const current = new Map(store.getState().shapes.map((s) => [s.id, s]));
  const next: CanvasShape[] = [];
  try {
    for (const patch of patches) {
      const id = patch.id;
      if (typeof id !== 'string') return { text: 'Error: each update needs an id', isError: true };
      const existing = current.get(id);
      if (!existing) return { text: `Error: no shape with id "${id}"`, isError: true };
      const merged: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
      merged.type = existing.type; // type is immutable on update
      next.push(normalizeShape(merged));
    }
    store.upsert(next);
    return { text: `Updated ${next.length} shape(s).` };
  } catch (e) {
    return { text: `Error: ${(e as Error).message}`, isError: true };
  }
}

export interface PlaceComponentInput {
  id?: string;
  module: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  data?: Record<string, unknown>;
  rev: number;
  /** The mart this instance renders (#239 / ADR-0017: a component names a mart, never
   * a URL). Optional and passed straight through to normalizeShape — no dataSource is
   * the existing static-data behavior, unchanged. */
  dataSource?: DataSource;
}

/** Place an instance of a component module on the canvas (or move/retarget by id). */
export function placeComponentOp(store: CanvasStore, input: PlaceComponentInput, originChatId?: string): OpResult {
  try {
    // Re-placing an existing instance must not unframe it: the agent's input never carries
    // parentId, so rebuilding from input alone silently dropped frame membership (and the
    // frame-relative coords then rendered as page coords — the post-deploy scatter bug).
    const existing = input.id ? store.getState().shapes.find((s) => s.id === input.id) : undefined;
    const shape = normalizeShape({
      ...(existing?.parentId ? { parentId: existing.parentId } : {}),
      type: 'component',
      id: input.id,
      x: input.x,
      y: input.y,
      w: input.w ?? 360,
      h: input.h ?? 260,
      module: input.module,
      data: input.data ?? {},
      rev: input.rev,
      ...(input.dataSource !== undefined ? { dataSource: input.dataSource } : {}),
    });
    // A freshly placed instance (new id) from a chat attaches to that chat through the
    // single attachBatchToChat seam. It RESPECTS the agent's (x,y) unless they are the
    // unset (0,0) placeholder: unlike create_shapes primitives, place_component is how the
    // agent composes deliberate multi-card layouts (e.g. a row of landing pages), so an
    // auto-tuck would destroy that layout. The (0,0)===unset convention lives ONLY here, at
    // the agent-input edge; tuck-or-not, root arrows, and the chat-missing fallback are all
    // the seam's job. Updating an existing instance by id leaves its position and links alone.
    const isNew = !input.id;
    if (isNew && originChatId) {
      const preservePosition = input.x !== 0 || input.y !== 0;
      const toUpsert = attachBatchToChat(store, [shape], originChatId, { preservePosition });
      store.upsert(toUpsert);
    } else {
      store.upsert([shape]);
    }
    const linked = isNew && originChatId ? ' (linked to the chat)' : '';
    return { text: `Placed <${input.module}> as ${shape.id}${linked}, ${input.w ?? 360}×${input.h ?? 260}.` };
  } catch (e) {
    return { text: `Error: ${(e as Error).message}`, isError: true };
  }
}

/** Update the props (data) of a placed component by id, leaving its module/box intact.
 * `dataSource` is optional (#239): omitted leaves an existing mart reference untouched,
 * passed retargets/attaches it — same "a component names a mart, never a URL" contract
 * as placeComponentOp. */
export function setComponentDataOp(store: CanvasStore, id: string, data: Record<string, unknown>, dataSource?: DataSource): OpResult {
  const existing = store.getState().shapes.find((s) => s.id === id);
  if (!existing || existing.type !== 'component') return { text: `Error: no component shape with id "${id}"`, isError: true };
  store.upsert([{ ...existing, data, ...(dataSource !== undefined ? { dataSource } : {}) }]);
  return { text: `Updated data for ${id}.` };
}

/** A rev greater than any component shape's current rev — guarantees a reload. */
export function nextComponentRev(store: CanvasStore): number {
  const revs = store.getState().shapes.filter((s) => s.type === 'component').map((s) => s.rev);
  return (revs.length ? Math.max(...revs) : 0) + 1;
}

/**
 * Bump `rev` on EVERY placed component, forcing the browser to re-import. Called
 * after any library write/edit: a leaf change must reload the containers that
 * import it (vite refreshes the transitive imports), so we reload all instances.
 */
export function bumpAllComponents(store: CanvasStore, rev: number): number {
  const affected = store.getState().shapes.filter((s) => s.type === 'component');
  if (affected.length) store.upsert(affected.map((s) => ({ ...s, rev })));
  return affected.length;
}

/** True when this canvas's store has at least one placed instance of `module`. */
export function placesModule(store: CanvasStore, module: string): boolean {
  return store.getState().shapes.some((s) => s.type === 'component' && s.module === module);
}

/**
 * The "who reloads" set for a workspace-level shared-component change (#55): given every
 * built session and the shared `module`, the exact sessions that placed it. A shared edit
 * or a promote must hot-reload only those canvases — a canvas that never placed the module
 * is untouched. Generalizes single-store `bumpAllComponents` to the cross-canvas fan-out;
 * pure over the session set (each just needs a `store`) so the target set is unit-testable.
 */
export function sessionsPlacingModule<T extends { store: CanvasStore }>(sessions: readonly T[], module: string): T[] {
  return sessions.filter((s) => placesModule(s.store, module));
}

/**
 * Bump every placing session's instances so each open canvas re-imports the changed shared
 * module (vite refreshes the transitive imports, so we reload all instances per store, as
 * the single-store path does). Returns the number of canvases reloaded. A broken shared edit
 * stays isolated per instance via the existing render error boundary.
 */
export function bumpSharedModule<T extends { store: CanvasStore }>(sessions: readonly T[], module: string): number {
  const targets = sessionsPlacingModule(sessions, module);
  for (const { store } of targets) bumpAllComponents(store, nextComponentRev(store));
  return targets.length;
}

export function deleteShapesOp(store: CanvasStore, ids: string[]): OpResult {
  store.remove(ids);
  return { text: `Deleted ${ids.length} shape(s).` };
}

export function clearOp(store: CanvasStore): OpResult {
  store.clear();
  return { text: 'Canvas cleared.' };
}

export function alignOp(store: CanvasStore, ids: string[], edge: AlignEdge): OpResult {
  const map = new Map(store.getState().shapes.map((s) => [s.id, s]));
  const boxes = ids
    .map((id) => map.get(id))
    .filter((s): s is CanvasShape => Boolean(s))
    .map((s) => ({ s, b: bounds(s) }))
    .filter((p): p is { s: CanvasShape; b: Box } => p.b !== null);
  if (boxes.length < 2) return { text: 'Error: need at least 2 alignable shapes', isError: true };

  const minX = Math.min(...boxes.map((p) => p.b.minX));
  const maxX = Math.max(...boxes.map((p) => p.b.maxX));
  const minY = Math.min(...boxes.map((p) => p.b.minY));
  const maxY = Math.max(...boxes.map((p) => p.b.maxY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const moved = boxes.map(({ s, b }) => {
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    switch (edge) {
      case 'left': return moveTo(s, minX, b.minY);
      case 'right': return moveTo(s, maxX - w, b.minY);
      case 'top': return moveTo(s, b.minX, minY);
      case 'bottom': return moveTo(s, b.minX, maxY - h);
      case 'center-x': return moveTo(s, cx - w / 2, b.minY);
      case 'center-y': return moveTo(s, b.minX, cy - h / 2);
    }
  });
  store.upsert(moved);
  return { text: `Aligned ${moved.length} shape(s) ${edge}.` };
}
