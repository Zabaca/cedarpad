// The agent write path, applied to a live `TLSocketRoom` (ADR-0019, #291). This is the
// only place that mutates a room outside the sync protocol itself.
//
// WHY `room.updateStore()` AND NOT `storage.transaction`: `updateStore` is deprecated in
// 5.2.5 in favour of the storage API, and we use it anyway, deliberately.
// `StoreUpdateContext.put()` calls `recordType.validate(record, recordBefore)`;
// `txn.set` is a RAW WRITE with no validation at all. Our zod contract validates the
// agent's INTENT — only tldraw can validate the resulting RECORD, and those are different
// assertions. A raw write means a malformed record persists and then breaks every client
// that loads the room: a corruption bug rather than a rejected request. We take the
// deprecation warning over that failure mode, and revisit when tldraw ships a validating
// transaction. See ADR-0019, "The write API".

import type { TLSocketRoom } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import type { CanvasMutation, CanvasMutationResult } from '../shared/canvas-mutation.ts';
import type { CanvasPage, CanvasShape } from '../src/shapes.ts';
import { arrowBindingId, buildArrowBindings, buildShapeRecord, plaintextOf, UnbuildableShapeError } from '../src/tl-record-builder.ts';
import type { ArrowBindingsView } from '../src/tldraw-conventions.ts';
import { fromTldrawShape } from '../src/tldraw-conventions.ts';
import type { SyncSessionMeta } from './sync-room.ts';

type Room = TLSocketRoom<TLRecord, SyncSessionMeta>;
type AnyRecord = TLRecord & Record<string, unknown>;

/** A write the room refused — either the builder could not author it, or tldraw's own
 *  `validate` threw inside `put()`. Either way NOTHING was persisted: `updateStore` is
 *  transactional, so a throw in the middle of a batch rolls the whole batch back. */
export class MutationRejected extends Error {}

const records = (room: Room): AnyRecord[] => room.getCurrentSnapshot().documents.map((d) => d.state as AnyRecord);

/**
 * The room's whole post-state, from a SINGLE snapshot.
 *
 * `getCurrentSnapshot()` materialises every record in the document, so it is the expensive
 * call here — and this runs on every mutation AND on every reopen between agent tool calls
 * (server/turn-canvas-store.ts), which makes it the hot path. Shapes, pages, and the
 * document clock therefore all come off one read rather than one apiece.
 *
 * The clock IS the version: monotonic, persisted in DO SQLite, and therefore (unlike the
 * in-memory counter it replaces) stable across a restart.
 */
function stateOf(room: Room): CanvasMutationResult {
  const snap = room.getCurrentSnapshot();
  const all = snap.documents.map((d) => d.state as AnyRecord);
  return { version: snap.documentClock ?? 0, shapes: shapesFrom(all), pages: orderedPages(all) };
}

/** Arrow id → which terminals are bound, read off the room's binding records. Sync-core
 *  stores bindings as plain records and has no binding logic; resolving them is ours. */
function bindingViews(all: AnyRecord[]): Map<string, ArrowBindingsView> {
  const out = new Map<string, ArrowBindingsView>();
  for (const r of all) {
    if (r.typeName !== 'binding' || r.type !== 'arrow') continue;
    const fromId = String(r.fromId);
    const terminal = (r.props as { terminal?: string } | undefined)?.terminal;
    if (terminal !== 'start' && terminal !== 'end') continue;
    const view = out.get(fromId) ?? {};
    view[terminal] = { toId: String(r.toId) };
    out.set(fromId, view);
  }
  return out;
}

/** Asset id → its `src`. An image shape holds only an `assetId`; the pixels (or, since
 *  #290, the `/api/canvas-assets/...` URL that serves them) live on a separate asset
 *  record. `snapshotToShapes` (worker/blob-to-snapshot.ts) resolves the same pointer the
 *  same way — without it every image reaches the agent with an empty `src` (#340). */
function assetSrcs(all: AnyRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of all) {
    if (r.typeName === 'asset') out.set(String(r.id), String((r.props as { src?: unknown } | undefined)?.src ?? ''));
  }
  return out;
}

/** The room's shape records, decoded back into the simplified model the agent reads.
 *  Ordered by id so reads are deterministic — the same guarantee `createStore` gives. */
export function readShapes(room: Room): CanvasShape[] {
  return shapesFrom(records(room));
}

/** As {@link readShapes}, over records already in hand — so a caller that also needs the
 *  pages or the clock does not pay for a second snapshot. */
function shapesFrom(all: AnyRecord[]): CanvasShape[] {
  const bindings = bindingViews(all);
  const assets = assetSrcs(all);
  const byId = new Map(all.map((r) => [String(r.id), r]));
  const defaultPage = firstPageId(all);
  const out: CanvasShape[] = [];
  for (const r of all) {
    if (r.typeName !== 'shape') continue;
    const plaintext = plaintextOf((r.props as { richText?: unknown } | undefined)?.richText);
    const assetId = (r.props as { assetId?: unknown } | undefined)?.assetId;
    const shape = fromTldrawShape(r as never, {
      plaintext,
      arrowBindings: bindings.get(String(r.id)),
      imageSrc: assetId ? assets.get(String(assetId)) : undefined,
    });
    if (shape) {
      // ABSENT MEANS THE DEFAULT PAGE. Tagging every shape unconditionally would change
      // the read shape of every single-page canvas — which is nearly all of them — and
      // spend tokens on a field that carries no information there.
      const page = pageOf(r, byId, defaultPage);
      if (page !== defaultPage) shape.page = page;
      out.push(shape);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The canvas's pages in tldraw's own order — also what the read path reports, so a caller
 *  can turn a human's page NAME into the id the write path takes. `index` is the fractional
 *  index the page switcher sorts by, so the FIRST of these is the page a human opens the
 *  canvas on — which is what makes it the right default for a shape that names no page.
 *  Falling back to record order (and then to sync-core's `page:page`) keeps a room with a
 *  malformed or absent page record answerable rather than throwing on read. */
function orderedPages(all: AnyRecord[]): CanvasPage[] {
  const pages = all.filter((r) => r.typeName === 'page');
  pages.sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')));
  return pages.map((p) => ({ id: String(p.id), name: String(p.name ?? '') }));
}

const firstPageId = (all: AnyRecord[]): string => orderedPages(all)[0]?.id ?? 'page:page';

/**
 * The page a shape sits on, walking up through any frames that contain it.
 *
 * A framed shape's `parentId` is the FRAME, not a page, so its page is its frame's page
 * (or its frame's frame's, for a nested frame). Without the walk every framed shape would
 * report the default page and an agent would move it across pages by accident.
 *
 * The `seen` guard is for a parent cycle. tldraw cannot produce one, but this reads
 * whatever is in the room — including records written by an older or buggier client — and
 * a read path that can hang is worse than one that answers the default.
 */
function pageOf(shape: AnyRecord, byId: Map<string, AnyRecord>, fallback: string): string {
  const seen = new Set<string>();
  let cur: AnyRecord | undefined = shape;
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    const parent = String(cur.parentId ?? '');
    if (parent.startsWith('page:')) return parent;
    if (!parent.startsWith('shape:')) return fallback;
    cur = byId.get(parent);
  }
  return fallback;
}

/**
 * Apply one contract-parsed mutation and answer with the room's post-state.
 *
 * Every op returns the full state, so the caller's mirror is refreshed by the same round
 * trip that wrote — there is no separate read to race against another writer.
 */
export async function applyMutation(room: Room, mutation: CanvasMutation): Promise<CanvasMutationResult> {
  if (mutation.op !== 'read') {
    const all = records(room);
    const pageId = firstPageId(all);
    const pages = new Set(orderedPages(all).map((p) => p.id));
    const existing = new Map(all.filter((r) => r.typeName === 'shape').map((r) => [String(r.id), r as TLRecord]));
    try {
      await room.updateStore((ctx) => {
        if (mutation.op === 'upsert') {
          for (const shape of mutation.shapes) {
            // A page the room does not have is REFUSED, not quietly redirected to the
            // default. Silently landing the shape somewhere else is the failure mode that
            // looks like data loss to the human: they asked for page 3, the agent said it
            // wrote, and nothing is there. `updateStore` is transactional, so throwing
            // here rolls the whole batch back.
            if (shape.page && !pages.has(shape.page)) {
              throw new UnbuildableShapeError(`no page "${shape.page}" on this canvas`);
            }
            ctx.put(buildShapeRecord(shape, existing.get(shape.id), pageId));
            // Referential integrity is ours (ADR-0019): a bound arrow's binding records
            // are written with the arrow, and re-put on every update so a rebind lands.
            for (const b of buildArrowBindings(shape)) ctx.put(b);
            if (shape.type === 'arrow') {
              for (const terminal of ['start', 'end'] as const) {
                const bound = terminal === 'start' ? shape.startShapeId : shape.endShapeId;
                if (!bound) ctx.delete(arrowBindingId(shape.id, terminal) as never);
              }
            }
          }
        } else {
          const doomed = mutation.op === 'clear' ? [...existing.keys()] : mutation.ids.filter((id) => existing.has(id));
          const gone = new Set(doomed);
          for (const id of doomed) ctx.delete(id as never);
          // ...and the bindings that referenced them, from either end. A dangling binding
          // is what breaks a client on load, and sync-core will not clean it up for us.
          //
          // WHEN BOTH ENDS GO, THE ARROW SURVIVES — unbound, not deleted. This is a
          // decision, not an accident (#292). The alternative was cascading the delete
          // onto the now-unattached arrow, and we rejected it:
          //   - tldraw's own editor does exactly this. `ArrowBindingUtil.arrowDidUpdate`
          //     calls `updateArrowTerminal({ ..., unbind: true })` when a bound shape is
          //     gone; the arrow stays. A human and an agent write the same room, so the
          //     server path must not answer the same event differently from the client.
          //   - the arrow is a shape the agent never asked us to remove, and it carries
          //     content of its own (its label). Cascading would delete authored text as a
          //     side effect of an unrelated delete.
          //   - unbinding is recoverable (re-upsert the arrow with terminals); a delete is
          //     not.
          // The unbound arrow is not a stub: `buildShapeRecord` stores the terminal
          // coordinates the agent authored in `props.start`/`props.end` even while a
          // binding overrides them, so dropping the binding restores those coordinates.
          // (The `{0,0}` in `arrowTerminal`, src/tldraw-conventions.ts, is a READ-side
          // convention for a bound terminal, not what is persisted.) Verified end to end
          // in e2e/specs/canvas-binding-cleanup.spec.ts.
          for (const r of all) {
            if (r.typeName !== 'binding') continue;
            if (gone.has(String(r.fromId)) || gone.has(String(r.toId))) ctx.delete(String(r.id) as never);
          }
        }
      });
    } catch (e) {
      throw new MutationRejected(e instanceof UnbuildableShapeError ? e.message : `tldraw rejected the record: ${(e as Error).message}`);
    }
  }
  return stateOf(room);
}
