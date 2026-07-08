// The PURE plan-builder half of the remote -> editor reconcile seam.
//
// Today `sync.ts`'s `reconcile()` reads a live `Editor`, diffs the remote
// `CanvasState` against it, and mutates the editor inside `mergeRemoteChanges`.
// This module factors the DECISION out of the mutation: given a plain snapshot of
// the editor (extracted by the caller) plus the remote state, it returns an
// ordered list of `ReconcileOp`s the caller then applies. No `Editor`, no DOM, no
// SSE, no tldraw runtime (tldraw is imported for TYPES only). That keeps the whole
// diff/order/hold/binding policy unit-testable in plain `bun test`.
//
// `sync.ts` routes its `reconcile()` through `planReconcile` and applies the ops;
// the diff/order/hold/binding helpers live here (and only here), not in `sync.ts`.

import type {
  TLAsset,
  TLAssetId,
  TLBindingCreate,
  TLBindingId,
  TLShape,
  TLShapeId,
  TLShapePartial,
} from 'tldraw';

import type { CanvasShape, CanvasState } from './shapes';
// All three are pure (type-only on tldraw, no Editor/DOM): `canon` for change
// detection, `toTldrawPartial` for the simplified -> tldraw partial assembly, and
// `imageAssetId` for the deterministic per-image asset id.
import { canon, imageAssetId, toTldrawPartial } from './tldraw-conventions';

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One terminal of an arrow's currently-resolved binding, as the snapshot carries it. */
export interface ArrowTerminalBinding {
  /** The binding record id (what a `bindingDelete` op targets). */
  id: string;
  /** The shape the terminal is currently bound to. */
  toId: string;
}

/** An arrow's currently-resolved start/end bindings (absent terminal = free point). */
export interface ArrowBindingPair {
  start?: ArrowTerminalBinding;
  end?: ArrowTerminalBinding;
}

/**
 * A plain, Editor-free snapshot of everything the planner needs to read off the
 * live editor. The caller (sync.ts) extracts this once per frame; the planner
 * never touches an `Editor`.
 */
export interface EditorSnapshot {
  /** Every shape record currently in the store, keyed by id (values unused beyond presence). */
  shapes: Map<string, TLShape>;
  /** Every asset record, keyed by asset id. */
  assets: Map<string, TLAsset>;
  /** Per-arrow resolved bindings, keyed by the arrow's shape id. */
  arrowBindings: Map<string, ArrowBindingPair>;
  /** The shape being text-edited, if any. */
  editingId: string | null;
  /** True while the human is dragging/pointing or text-editing (shapes are mid-flight). */
  interacting: boolean;
  /** The currently-selected shape ids. */
  selectedIds: Set<string>;
  /**
   * `canon()` of each existing shape decoded back to the simplified model, keyed
   * by shape id. A missing entry for a present shape (e.g. an un-modelable type)
   * is treated as "changed", matching the old `!cur` branch.
   */
  canonical: Map<string, string>;
}

/** Everything the planner needs that is not on the editor snapshot. */
export interface ReconcileInput {
  remote: CanvasState;
  lastVersion: number;
  snapshot: EditorSnapshot;
  /** Shape ids the server has ever sent (only these are ever deleted locally). */
  mirroredShapes: Set<string>;
}

/**
 * One unit of work to apply to the editor. The kinds are batched (one op per kind
 * per frame), and the planner emits them in a fixed sequence (see `OP_ORDER`).
 */
export type ReconcileOp =
  | { kind: 'assetCreate'; assets: TLAsset[] }
  | { kind: 'assetUpdate'; assets: TLAsset[] }
  | { kind: 'shapeCreate'; partials: TLShapePartial[] }
  | { kind: 'shapeUpdate'; partials: TLShapePartial[] }
  | { kind: 'shapeDelete'; ids: TLShapeId[] }
  | { kind: 'bindingDelete'; ids: TLBindingId[] }
  | { kind: 'bindingCreate'; bindings: TLBindingCreate[] };

export interface ReconcilePlan {
  ops: ReconcileOp[];
  nextVersion: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (the diff/order/binding logic; live only here)
// ─────────────────────────────────────────────────────────────────────────────

const dataUrlMime = (src: string): string => /^data:([^;,]+)/.exec(src)?.[1] ?? 'image/png';

// Identity text encoder. `toTldrawPartial` takes the text encoder as a parameter
// so it never imports the DOM-coupled `toRichText`; the planner's job is the
// diff/order/hold/binding plan, not text encoding, so it passes a pure pass-through
// (the same convention the tldraw-conventions unit tests use). `sync.ts`'s applyOps
// supplies the real encoder at apply time.
const passthroughText = (plain: string): string => plain;

// Order partials so a frame is created before any child that parents to it. tldraw
// places a shape under `parentId` only if the parent already exists, so when a
// frame and its children arrive in the same batch the frame must come first.
// Depth-first over in-batch parents handles nesting.
function orderByParent(partials: TLShapePartial[]): TLShapePartial[] {
  const byId = new Map(partials.map((p) => [p.id as string, p]));
  const placed = new Set<string>();
  const out: TLShapePartial[] = [];
  const visit = (p: TLShapePartial) => {
    const id = p.id as string;
    if (placed.has(id)) return;
    const pid = (p as { parentId?: string }).parentId;
    if (pid && byId.has(pid) && !placed.has(pid)) visit(byId.get(pid)!);
    placed.add(id);
    out.push(p);
  };
  for (const p of partials) visit(p);
  return out;
}

// Image pixels live in a tldraw ASSET record, not the shape. Before (re)creating an
// image shape, its asset must be materialized from the carried `src` data URL:
// create it if missing, or update its src if it changed (so a late-arriving src
// from another client actually lands). Returns the create/update batches.
function planImageAssets(
  remote: Map<string, CanvasShape>,
  assets: Map<string, TLAsset>,
): { create: TLAsset[]; update: TLAsset[] } {
  const create: TLAsset[] = [];
  const update: TLAsset[] = [];
  for (const s of remote.values()) {
    if (s.type !== 'image' || !s.src) continue;
    const id = imageAssetId(s.id) as TLAssetId;
    const existing = assets.get(id as unknown as string);
    if (!existing) {
      create.push({
        id,
        typeName: 'asset',
        type: 'image',
        meta: {},
        props: { w: s.w, h: s.h, name: s.alt || 'image', isAnimated: false, mimeType: dataUrlMime(s.src), src: s.src },
      } as unknown as TLAsset);
    } else if ((existing.props as { src?: string | null }).src !== s.src) {
      update.push({ ...existing, props: { ...existing.props, src: s.src } } as TLAsset);
    }
  }
  return { create, update };
}

// The fixed apply sequence. Assets exist before the shapes that reference them;
// bindings reconcile after both arrow and target shapes exist.
const OP_ORDER: ReadonlyArray<ReconcileOp['kind']> = [
  'assetCreate',
  'assetUpdate',
  'shapeCreate',
  'shapeUpdate',
  'shapeDelete',
  'bindingDelete',
  'bindingCreate',
];

// ─────────────────────────────────────────────────────────────────────────────
// The planner
// ─────────────────────────────────────────────────────────────────────────────

export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const { remote: state, lastVersion, snapshot, mirroredShapes } = input;

  // Version-watermark gate: ignore an echo of (or older than) what we last applied.
  if (state.version <= lastVersion) {
    return { ops: [], nextVersion: lastVersion };
  }
  const nextVersion = state.version;

  const remote = new Map(state.shapes.map((s) => [s.id, s]));

  // While the human is actively pointing/dragging/text-editing, the shapes they're
  // manipulating are mid-flight; applying a remote echo to them snaps them back.
  // Hold off touching those: they get neither a shapeUpdate nor a shapeDelete.
  const held = new Set<string>();
  if (snapshot.interacting) for (const id of snapshot.selectedIds) held.add(id);
  if (snapshot.editingId) held.add(snapshot.editingId);

  const toCreate: TLShapePartial[] = [];
  const toUpdate: TLShapePartial[] = [];
  const toDelete: TLShapeId[] = [];

  for (const [id, rs] of remote) {
    const partial = toTldrawPartial(rs, passthroughText);
    if (!partial) continue; // not representable (freehand draw)
    const existing = snapshot.shapes.has(id);
    if (existing && held.has(id)) continue; // mid-drag: leave the human's live shape alone
    if (!existing) {
      toCreate.push(partial);
    } else {
      const curCanon = snapshot.canonical.get(id);
      if (curCanon === undefined || curCanon !== canon(rs)) {
        // Don't reparent an existing shape on update (tldraw fights it and it would
        // churn); only position/props/bindings update in place.
        delete (partial as { parentId?: string }).parentId;
        toUpdate.push(partial);
      }
    }
  }
  for (const id of snapshot.shapes.keys()) {
    if (!remote.has(id) && mirroredShapes.has(id) && id !== snapshot.editingId && !held.has(id)) {
      toDelete.push(id as TLShapeId);
    }
  }

  const createPartials = orderByParent(toCreate);
  const createdIds = new Set(createPartials.map((p) => p.id as string));

  // A terminal binds to a target only if the target will exist after the creates
  // (already present, or created this batch); else it stays a free point.
  const targetExists = (toId: string | undefined): boolean =>
    !!toId && (snapshot.shapes.has(toId) || createdIds.has(toId));

  const bindingDelete: TLBindingId[] = [];
  const bindingCreate: TLBindingCreate[] = [];
  const planTerminal = (arrowId: string, terminal: 'start' | 'end', desiredToId: string | undefined, current: ArrowTerminalBinding | undefined) => {
    const desired = targetExists(desiredToId) ? desiredToId : undefined;
    if (desired === current?.toId) return; // already correct (or both absent)
    if (current) bindingDelete.push(current.id as unknown as TLBindingId);
    if (desired) {
      bindingCreate.push({
        type: 'arrow',
        fromId: arrowId as TLShapeId,
        toId: desired as TLShapeId,
        props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      } as unknown as TLBindingCreate);
    }
  };
  for (const rs of remote.values()) {
    if (rs.type !== 'arrow') continue;
    // The arrow must exist after creates for its bindings to attach to anything.
    if (!(snapshot.shapes.has(rs.id) || createdIds.has(rs.id))) continue;
    const current = snapshot.arrowBindings.get(rs.id);
    planTerminal(rs.id, 'start', rs.startShapeId, current?.start);
    planTerminal(rs.id, 'end', rs.endShapeId, current?.end);
  }

  const assetBatches = planImageAssets(remote, snapshot.assets);

  // Assemble into the fixed apply sequence, dropping empty op kinds.
  const byKind: Partial<Record<ReconcileOp['kind'], ReconcileOp>> = {};
  if (assetBatches.create.length) byKind.assetCreate = { kind: 'assetCreate', assets: assetBatches.create };
  if (assetBatches.update.length) byKind.assetUpdate = { kind: 'assetUpdate', assets: assetBatches.update };
  if (createPartials.length) byKind.shapeCreate = { kind: 'shapeCreate', partials: createPartials };
  if (toUpdate.length) byKind.shapeUpdate = { kind: 'shapeUpdate', partials: toUpdate };
  if (toDelete.length) byKind.shapeDelete = { kind: 'shapeDelete', ids: toDelete };
  if (bindingDelete.length) byKind.bindingDelete = { kind: 'bindingDelete', ids: bindingDelete };
  if (bindingCreate.length) byKind.bindingCreate = { kind: 'bindingCreate', bindings: bindingCreate };

  const ops: ReconcileOp[] = [];
  for (const kind of OP_ORDER) {
    const op = byKind[kind];
    if (op) ops.push(op);
  }

  return { ops, nextVersion };
}
