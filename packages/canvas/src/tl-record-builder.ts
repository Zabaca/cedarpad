// The typed builder: simplified `CanvasShape` intent → a COMPLETE, valid `TLRecord`
// (ADR-0019, #291). Agents never hand-craft records; they send intent and this is the
// only thing that turns intent into a record.
//
// React-free and DOM-free, for the same reason src/shape-props.ts is: it runs inside the
// Durable Object. It reuses `toTldrawPartial` (src/tldraw-conventions.ts), which is
// already the single source of truth for the model→tldraw mapping, and adds the two
// things a *record* needs that a *partial* does not:
//
//   1. the record-level fields (`typeName`/`rotation`/`index`/`parentId`/`isLocked`/
//      `opacity`/`meta`), and
//   2. COMPLETE props. `StoreUpdateContext.put()` validates the whole record, so a prop
//      the agent never mentions (`dash`, `font`, …) must still be present. On an UPDATE
//      the existing record supplies them, which also means an update preserves whatever
//      the human set in the browser; only on a CREATE do the tables below apply.

import { toRichText } from '@tldraw/tlschema';
import type { TLRecord } from '@tldraw/tlschema';

import type { CanvasShape } from './shapes';
import { toTldrawPartial } from './tldraw-conventions';

/** Plain text out of a tldraw richText value, without importing tldraw's runtime
 *  (`toRichText`'s inverse lives in @tldraw/editor, which drags in the DOM). Paragraphs
 *  join with a newline, mirroring how the browser shell decodes them. */
export function plaintextOf(richText: unknown): string {
  const collect = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (typeof n.text === 'string') return n.text;
    const inner = (n.content ?? []).map(collect);
    return n.type === 'doc' ? inner.join('\n') : inner.join('');
  };
  return collect(richText);
}

/**
 * Default props per tldraw shape type, for the CREATE path only. Hand-maintained because
 * tldraw's own defaults live on the `ShapeUtil`s in @tldraw/editor (React) and cannot be
 * imported here. Every entry is verified against `recordType.validate` by the round-trip
 * tests — a wrong or missing key is a rejected write, not a silent default.
 */
const DEFAULT_PROPS: Record<string, Record<string, unknown>> = {
  geo: {
    geo: 'rectangle',
    dash: 'draw',
    url: '',
    w: 100,
    h: 100,
    growY: 0,
    scale: 1,
    labelColor: 'black',
    color: 'black',
    fill: 'none',
    size: 'm',
    font: 'draw',
    align: 'middle',
    verticalAlign: 'middle',
    richText: toRichText(''),
  },
  text: { color: 'black', size: 'm', font: 'draw', textAlign: 'start', w: 100, richText: toRichText(''), scale: 1, autoSize: true },
  note: {
    color: 'black',
    labelColor: 'black',
    size: 'm',
    font: 'draw',
    // 1, NOT 0 — this is a MULTIPLIER, and tldraw's own note default is 1.
    // `NoteShapeUtil` renders the label at `(fontSizeAdjustment ?? 1) * labelFontSize`,
    // and `0 ?? 1` is 0 (nullish coalescing does not catch 0), so a 0 here draws every
    // note's text at 0px: present, correct, and invisible. It survived review because it
    // is not data loss — the richText is intact and `verify` compares the shape model,
    // not tldraw's render props. Regression: it shipped in the 2026-07-28 cutover and hid
    // the text on every migrated sticky note.
    fontSizeAdjustment: 1,
    align: 'middle',
    verticalAlign: 'middle',
    growY: 0,
    url: '',
    richText: toRichText(''),
    scale: 1,
    textLastEditedBy: null,
  },
  arrow: {
    kind: 'arc',
    labelColor: 'black',
    color: 'black',
    fill: 'none',
    dash: 'draw',
    size: 'm',
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
    font: 'draw',
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
    bend: 0,
    richText: toRichText(''),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
  },
  frame: { w: 320, h: 240, name: '', color: 'black' },
  component: { w: 360, h: 260, module: '', data: {}, rev: 0, dataSource: null },
  chat: { w: 380, h: 460, title: '', chatId: '' },
};

/** Fractional index for a newly created shape. Every agent-created shape lands on the
 *  same index; tldraw treats equal indexes as a stable tie broken by id, which is fine —
 *  z-order among agent shapes is not something an agent expresses. */
const CREATE_INDEX = 'a1';

export class UnbuildableShapeError extends Error {}

/**
 * Build the record to `put()`. `existing` is the record already in the room (an UPDATE)
 * or `undefined` (a CREATE). Throws `UnbuildableShapeError` for a shape this path cannot
 * author — `draw` is human-only (ADR-0019 keeps it out of the agent's vocabulary), and
 * `image`/`embed` need pixels or an asset the agent has no way to supply on a create.
 */
export function buildShapeRecord(shape: CanvasShape, existing: TLRecord | undefined, pageId: string): TLRecord {
  const partial = toTldrawPartial(shape, toRichText);
  if (!partial) throw new UnbuildableShapeError(`${shape.type} shapes are human-authored; the agent cannot create one`);
  const type = partial.type as string;
  const defaults = DEFAULT_PROPS[type];
  const prior = existing as unknown as { props?: Record<string, unknown> } | undefined;
  if (!prior && !defaults) {
    throw new UnbuildableShapeError(`cannot create a ${shape.type} shape: no server-side defaults for tldraw type "${type}"`);
  }
  const baseProps = prior?.props ?? defaults;
  return {
    ...(existing ?? {}),
    typeName: 'shape',
    id: partial.id,
    type,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    rotation: (existing as unknown as { rotation?: number } | undefined)?.rotation ?? 0,
    index: (existing as unknown as { index?: string } | undefined)?.index ?? CREATE_INDEX,
    parentId: (partial as unknown as { parentId?: string }).parentId ?? (existing as unknown as { parentId?: string } | undefined)?.parentId ?? pageId,
    isLocked: (existing as unknown as { isLocked?: boolean } | undefined)?.isLocked ?? false,
    opacity: (existing as unknown as { opacity?: number } | undefined)?.opacity ?? 1,
    meta: (existing as unknown as { meta?: Record<string, unknown> } | undefined)?.meta ?? {},
    props: { ...baseProps, ...((partial as unknown as { props?: Record<string, unknown> }).props ?? {}) },
  } as unknown as TLRecord;
}

/** A binding record id derived from its arrow + terminal, so rebuilding the same bound
 *  arrow reuses the binding instead of accumulating duplicates. */
export const arrowBindingId = (arrowId: string, terminal: 'start' | 'end'): string =>
  `binding:${arrowId.replace(/^shape:/, '')}-${terminal}`;

/**
 * The arrow-binding records for a bound arrow. Sync-core has no binding logic at all, so
 * referential integrity is ours (ADR-0019): these are written alongside the arrow, and
 * `applyMutation` deletes them when either endpoint disappears.
 */
export function buildArrowBindings(shape: CanvasShape): TLRecord[] {
  if (shape.type !== 'arrow') return [];
  const out: TLRecord[] = [];
  for (const terminal of ['start', 'end'] as const) {
    const toId = terminal === 'start' ? shape.startShapeId : shape.endShapeId;
    if (!toId) continue;
    out.push({
      id: arrowBindingId(shape.id, terminal),
      typeName: 'binding',
      type: 'arrow',
      fromId: shape.id,
      toId,
      meta: {},
      props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
    } as unknown as TLRecord);
  }
  return out;
}
