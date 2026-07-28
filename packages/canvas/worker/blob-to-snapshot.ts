// Reshape a canvas's persisted `canvas-state.json` blob into a tldraw sync ROOM
// SNAPSHOT, and back (ADR-0019, #295).
//
// The issue framed this as "reshaping, not translating". It is not: `canvas-state.json`
// holds the SIMPLIFIED `CanvasShape` model (src/shapes.ts), not tldraw records. Real
// tldraw records only ever existed in the browser, which built them with an `Editor`.
// So this module has to do what the browser did — with no Editor, no React, no DOM,
// because the destination is a Durable Object.
//
// Two halves, both pure:
//   blobToRoomSnapshot  CanvasState -> RoomSnapshot   (the import)
//   snapshotToShapes    RoomSnapshot -> CanvasShape[] (what `verify` diffs against)
//
// The per-shape field mapping is NOT duplicated here: it is the existing pure
// `toTldrawPartial` / `fromTldrawShape` in src/tldraw-conventions.ts — the same rules
// the browser applies. This module adds only what a partial leaves out and an Editor
// used to supply: complete default props, the record envelope, page/index/parent
// wiring, arrow bindings, and image assets.

import { getIndices } from '@tldraw/utils';
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  DefaultHorizontalAlignStyle,
  DefaultSizeStyle,
  DefaultTextAlignStyle,
  DefaultVerticalAlignStyle,
  toRichText,
  type TLRecord,
  type TLRichText,
} from '@tldraw/tlschema';
import type { RoomSnapshot } from '@tldraw/sync-core';

import type { CanvasShape, CanvasState } from '../src/shapes.ts';
import { fromTldrawShape, imageAssetId, toTldrawPartial } from '../src/tldraw-conventions.ts';
import { createCanvasTLSchema } from '../src/tl-schema.ts';

const PAGE_ID = 'page:page';
const DOCUMENT_ID = 'document:document';

/** The document + page every tldraw store needs. Matches sync-core's own default
 *  initial snapshot, so an imported room is indistinguishable from a fresh one. */
function baseRecords(): TLRecord[] {
  return [
    { id: DOCUMENT_ID, typeName: 'document', gridSize: 10, name: '', meta: {} },
    { id: PAGE_ID, typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
  ] as unknown as TLRecord[];
}

// ---------------------------------------------------------------------------
// default props
// ---------------------------------------------------------------------------

// An `Editor` filled these from each ShapeUtil's `getDefaultProps()`; a DO has no
// ShapeUtils. Style props read their default off the StyleProp itself (the single
// source of truth tlschema exposes); the rest are tldraw's documented defaults for a
// freshly created shape. Anything `toTldrawPartial` sets overrides these.
const styleDefaults = {
  color: DefaultColorStyle.defaultValue,
  labelColor: DefaultColorStyle.defaultValue,
  fill: DefaultFillStyle.defaultValue,
  dash: DefaultDashStyle.defaultValue,
  size: DefaultSizeStyle.defaultValue,
  font: DefaultFontStyle.defaultValue,
  align: DefaultHorizontalAlignStyle.defaultValue,
  verticalAlign: DefaultVerticalAlignStyle.defaultValue,
  textAlign: DefaultTextAlignStyle.defaultValue,
};

const emptyRichText = (): TLRichText => toRichText('');

const DEFAULT_PROPS: Record<string, () => Record<string, unknown>> = {
  geo: () => ({
    geo: 'rectangle',
    dash: styleDefaults.dash,
    url: '',
    w: 100,
    h: 100,
    growY: 0,
    scale: 1,
    labelColor: styleDefaults.labelColor,
    color: styleDefaults.color,
    fill: styleDefaults.fill,
    size: styleDefaults.size,
    font: styleDefaults.font,
    align: styleDefaults.align,
    verticalAlign: styleDefaults.verticalAlign,
    richText: emptyRichText(),
  }),
  text: () => ({
    color: styleDefaults.color,
    size: styleDefaults.size,
    font: styleDefaults.font,
    textAlign: styleDefaults.textAlign,
    w: 8,
    richText: emptyRichText(),
    scale: 1,
    autoSize: true,
  }),
  note: () => ({
    color: styleDefaults.color,
    labelColor: styleDefaults.labelColor,
    size: styleDefaults.size,
    font: styleDefaults.font,
    fontSizeAdjustment: 0,
    align: styleDefaults.align,
    verticalAlign: styleDefaults.verticalAlign,
    growY: 0,
    url: '',
    richText: emptyRichText(),
    scale: 1,
    textLastEditedBy: null,
  }),
  arrow: () => ({
    kind: 'arc',
    labelColor: styleDefaults.labelColor,
    color: styleDefaults.color,
    fill: styleDefaults.fill,
    dash: styleDefaults.dash,
    size: styleDefaults.size,
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
    font: styleDefaults.font,
    start: { x: 0, y: 0 },
    end: { x: 2, y: 0 },
    bend: 0,
    richText: emptyRichText(),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
  }),
  frame: () => ({ w: 160, h: 90, name: '', color: styleDefaults.color }),
  image: () => ({
    w: 100,
    h: 100,
    playing: true,
    url: '',
    assetId: null,
    crop: null,
    flipX: false,
    flipY: false,
    altText: '',
  }),
  embed: () => ({ w: 300, h: 300, url: '' }),
  draw: () => ({
    color: styleDefaults.color,
    fill: styleDefaults.fill,
    dash: styleDefaults.dash,
    size: styleDefaults.size,
    segments: [],
    isComplete: false,
    isClosed: false,
    isPen: false,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
  }),
  component: () => ({ w: 360, h: 260, module: '', data: {}, rev: 0, dataSource: null }),
  chat: () => ({ w: 380, h: 460, title: '', chatId: '' }),
};

// ---------------------------------------------------------------------------
// blob -> snapshot
// ---------------------------------------------------------------------------

/**
 * Every record a room needs to hold this canvas: the document, the page, one shape
 * record per representable blob shape, an `image` asset per image shape, and an
 * `arrow` binding per bound arrow terminal.
 *
 * TWO LOSSY CASES, both deliberate, both reported so the migration can never lose them
 * silently (the script refuses to `load` a dump containing either without `--accept-loss`):
 *
 *   - `draw` shapes are dropped. `toTldrawPartial` returns null for them: the simplified
 *     model keeps only flattened points, never tldraw's segments/pressure, so there is
 *     nothing to rebuild a stroke from.
 *   - an arrow with a binding to a shape that is not on this canvas is dropped WHOLE.
 *     A bound terminal stores `{0,0}` — the binding, not the coordinate, is the truth —
 *     so migrating such an arrow draws a line to the origin. That is visibly wrong and
 *     reads as a rendering bug; a missing arrow at least reads as missing.
 */
export function canvasRecords(state: CanvasState): {
  records: TLRecord[];
  dropped: CanvasShape[];
  dangling: Array<{ arrowId: string; terminal: 'start' | 'end'; toId: string }>;
} {
  const records: TLRecord[] = baseRecords();
  const dropped: CanvasShape[] = [];
  const dangling: Array<{ arrowId: string; terminal: 'start' | 'end'; toId: string }> = [];
  // Blob order IS z-order (the bridge appends), so indices follow it.
  const indices = getIndices(state.shapes.length);
  const ids = new Set(state.shapes.map((s) => s.id));

  state.shapes.forEach((shape, i) => {
    // An arrow with ANY unresolvable binding is dropped whole, before it becomes a record.
    const bad = danglingTerminals(shape, ids);
    if (bad.length > 0) {
      dangling.push(...bad);
      dropped.push(shape);
      return;
    }
    // The text encoder is `toRichText` from @tldraw/tlschema — React-free, the same
    // function the browser shell injects (src/tldraw-bridge.ts).
    const partial = toTldrawPartial(shape, toRichText);
    if (!partial) {
      dropped.push(shape);
      return;
    }
    const type = partial.type as string;
    const props = { ...DEFAULT_PROPS[type]?.(), ...(partial.props ?? {}) };
    // A frame parent that isn't in this canvas would dangle; fall back to the page.
    const parent = shape.parentId && ids.has(shape.parentId) ? shape.parentId : PAGE_ID;
    records.push({
      id: partial.id,
      typeName: 'shape',
      type,
      x: partial.x ?? 0,
      y: partial.y ?? 0,
      rotation: 0,
      index: indices[i + 1],
      parentId: parent,
      isLocked: false,
      opacity: 1,
      meta: shape.type === 'component' && shape.status ? { status: shape.status } : {},
      props,
    } as unknown as TLRecord);

    if (shape.type === 'image') records.push(imageAsset(shape));
    if (shape.type === 'arrow') {
      // Every binding here resolves — `danglingTerminals` already refused the arrow if not.
      if (shape.startShapeId) records.push(arrowBinding(shape.id, 'start', shape.startShapeId));
      if (shape.endShapeId) records.push(arrowBinding(shape.id, 'end', shape.endShapeId));
    }
  });

  return { records, dropped, dangling };
}

/**
 * The bindings on `shape` that point at a shape which is not on this canvas.
 *
 * Such a binding cannot be recreated: sync-core has no binding logic (ADR-0019), so
 * nothing would ever clean up a binding record pointing at nothing. And the arrow cannot
 * be kept without it either — a bound terminal stores `{0,0}`, so the arrow would render
 * as a line to the origin. The blob was already inconsistent; the honest result is to
 * report it and migrate neither.
 */
function danglingTerminals(
  shape: CanvasShape,
  ids: Set<string>,
): Array<{ arrowId: string; terminal: 'start' | 'end'; toId: string }> {
  if (shape.type !== 'arrow') return [];
  const out: Array<{ arrowId: string; terminal: 'start' | 'end'; toId: string }> = [];
  for (const [terminal, toId] of [
    ['start', shape.startShapeId],
    ['end', shape.endShapeId],
  ] as const) {
    if (toId && !ids.has(toId)) out.push({ arrowId: shape.id, terminal, toId });
  }
  return out;
}

/**
 * What the ROOM should end up holding for this blob, as the simplified model: the source
 * shapes minus the two known-unmigratable cases (`draw`, and bindings to shapes that
 * aren't on the canvas). `verify` diffs against THIS, not the raw blob, so those two are
 * counted and named rather than showing up as anonymous mismatches — and any OTHER
 * difference stays a hard failure.
 */
export function expectedShapes(state: CanvasState): CanvasShape[] {
  const ids = new Set(state.shapes.map((s) => s.id));
  const out: CanvasShape[] = [];
  for (const shape of state.shapes) {
    if (shape.type === 'draw') continue;
    if (danglingTerminals(shape, ids).length > 0) continue;
    // A frame parent that isn't on the canvas is NOT a loss: the shape survives, merely
    // reparented to the page (see `canvasRecords`), so the expectation drops the field.
    out.push(shape.parentId && !ids.has(shape.parentId) ? stripKey(shape, 'parentId') : shape);
  }
  return out;
}

function stripKey<T extends object>(v: T, key: keyof T): T {
  const { [key]: _drop, ...rest } = v;
  return rest as T;
}

/**
 * The pixels live in their own asset record; the shape only names it (`imageAssetId`).
 *
 * `fileSize` is OMITTED rather than set to a sentinel: it is `T.nonZeroNumber.optional()`,
 * so tldraw's usual "unknown" value of -1 is rejected outright. The round-trip tests could
 * not see this — `fromTldrawShape` reads only `props.src` — which is exactly why
 * `invalidRecords` exists. The asset's `w`/`h` mirror the shape's box; the true pixel
 * dimensions are not in the blob, and nothing reads them for a data-URL asset.
 */
function imageAsset(shape: { id: string; src: string; w: number; h: number }): TLRecord {
  const mimeType = /^data:([^;,]+)/.exec(shape.src)?.[1] ?? null;
  return {
    id: imageAssetId(shape.id),
    typeName: 'asset',
    type: 'image',
    meta: {},
    props: { w: shape.w, h: shape.h, name: '', isAnimated: false, mimeType, src: shape.src },
  } as unknown as TLRecord;
}

/** One `arrow` binding record for a bound terminal. Centre anchor + non-precise, which
 *  is tldraw's "snapped to the shape, position decided by the arrow" default — the
 *  simplified model records only THAT a terminal is bound, never where. */
function arrowBinding(arrowId: string, terminal: 'start' | 'end', toId: string): TLRecord {
  return {
    id: `binding:${arrowId.replace(/^shape:/, '')}-${terminal}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowId,
    toId,
    meta: {},
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
  } as unknown as TLRecord;
}

/**
 * A room snapshot at clock 0 — a fresh room's document, replaced wholesale.
 *
 * `schema` is `createCanvasTLSchema().serialize()`: the CURRENT version of the same
 * factory the DO and the browser build from. It is not decoration — sync-core migrates
 * every incoming document to the room's schema, so stamping the current version says
 * "these records need no migration", which is true: they were built from it moments ago.
 */
export function blobToRoomSnapshot(state: CanvasState): RoomSnapshot {
  const { records } = canvasRecords(state);
  return {
    clock: 0,
    documentClock: 0,
    tombstoneHistoryStartsAtClock: 0,
    schema: createCanvasTLSchema().serialize(),
    documents: records.map((state) => ({ state, lastChangedClock: 0 })),
  };
}

/**
 * Every record in `snapshot` that `createCanvasTLSchema()` rejects, as readable messages.
 * Empty means the snapshot is safe to load.
 *
 * This exists because **`TLSocketRoom.loadSnapshot()` does not validate.** It writes the
 * records straight into storage — an invalid record is accepted at import and then breaks
 * every client that loads the room afterwards. That is precisely the corruption failure
 * mode ADR-0019 chose the deprecated `room.updateStore()` over `storage.transaction` to
 * avoid; `loadSnapshot` has the same hole, so the check has to be ours.
 */
export function invalidRecords(snapshot: RoomSnapshot): string[] {
  const schema = createCanvasTLSchema();
  const problems: string[] = [];
  for (const { state } of snapshot.documents) {
    try {
      // A snapshot's `documents` are `UnknownRecord` — deliberately, since the whole point
      // is that they might NOT be valid TLRecords. Deciding that is what this call does.
      schema.validateRecord(null as never, state as TLRecord, 'initialize', null);
    } catch (e) {
      problems.push(`${String(state.id)}: ${(e as Error).message}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// snapshot -> blob (the verify side)
// ---------------------------------------------------------------------------

/** Plain text out of a tiptap doc — the inverse of `toRichText`, which is all this
 *  needs to undo. `renderPlaintextFromRichText` is Editor-coupled and unavailable here. */
function plaintextOf(rich: unknown): string {
  const doc = rich as { content?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
  if (!doc?.content) return '';
  return doc.content.map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join('\n');
}

/**
 * Read a room snapshot back as the simplified model, so it can be compared field by
 * field with the source blob. Decoding is the pure `fromTldrawShape`; this supplies
 * the three inputs the browser shell resolves off an Editor.
 */
export function snapshotToShapes(snapshot: RoomSnapshot): CanvasShape[] {
  const shapes: TLRecord[] = [];
  const assets = new Map<string, string>();
  const bindings = new Map<string, { start?: { toId: string }; end?: { toId: string } }>();

  for (const { state } of snapshot.documents) {
    const rec = state as unknown as TLRecord & { props?: Record<string, unknown> };
    if (rec.typeName === 'shape') shapes.push(rec);
    else if (rec.typeName === 'asset') assets.set(rec.id, String(rec.props?.src ?? ''));
    else if (rec.typeName === 'binding') {
      const from = String((rec as unknown as { fromId: string }).fromId);
      const view = bindings.get(from) ?? {};
      view[rec.props?.terminal as 'start' | 'end'] = { toId: String((rec as unknown as { toId: string }).toId) };
      bindings.set(from, view);
    }
  }

  const out: CanvasShape[] = [];
  // A snapshot's `documents` are in no particular order. Sort by the fractional index,
  // which IS z-order — and, because `canvasRecords` assigns indices in blob order, also
  // restores the blob's own order so `verify` can compare position by position.
  // Compared by code unit, NOT localeCompare: fractional index keys are base-62 and
  // case-significant ('Z' sorts before 'a'), which a locale collation would reverse.
  const idx = (r: TLRecord) => String((r as unknown as { index: string }).index);
  shapes.sort((a, b) => (idx(a) < idx(b) ? -1 : idx(a) > idx(b) ? 1 : 0));
  for (const rec of shapes) {
    const props = (rec as unknown as { props: Record<string, unknown> }).props;
    const decoded = fromTldrawShape(rec as never, {
      plaintext: plaintextOf(props.richText),
      arrowBindings: bindings.get(rec.id),
      imageSrc: props.assetId ? assets.get(String(props.assetId)) : undefined,
    });
    if (decoded) out.push(decoded);
  }
  return out;
}
