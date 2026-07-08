// Wire a tldraw Editor to the bridge. Two directions, both echo-safe:
//   remote -> editor: an SSE stream of full canvas state. Each frame is turned into
//                     an ordered ReconcileOp plan by the pure `planReconcile`
//                     (sync-plan.ts), then applied to the editor inside
//                     mergeRemoteChanges() so the edits are NOT pushed back up (the
//                     push listener is scoped to source: 'user').
//   editor -> remote: the user's document changes, translated and POSTed
//                     (debounced to batch drags).

import {
  type Editor,
  type TLArrowShape,
  type TLAsset,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  getArrowBindings,
  toRichText,
} from 'tldraw';

import type { CanvasShape, CanvasState } from './shapes';
import { fromTldrawShape } from './tldraw-bridge';
import { canon } from './tldraw-conventions';
import { planReconcile, type ArrowBindingPair, type EditorSnapshot, type ReconcileOp } from './sync-plan';
import { registerStream } from './idle';
import { withCanvasHeader, withCanvasParam } from './active-canvas';

// ─────────────────────────────────────────────────────────────────────────────
// remote -> editor: snapshot the live editor, plan with the pure planner, apply.
// Every diff/order/hold/fallback/binding DECISION lives in `planReconcile`; this
// module only reads the editor into a plain snapshot and writes the resulting ops
// back. There is no second reconcile code path.
// ─────────────────────────────────────────────────────────────────────────────

// A plain, Editor-free snapshot of everything the planner reads off the editor,
// built in one pass over the store. The planner never touches an `Editor`; this is
// the only place those reads happen.
function snapshotEditor(editor: Editor): EditorSnapshot {
  const shapes = new Map<string, TLShape>();
  const assets = new Map<string, TLAsset>();
  for (const r of editor.store.allRecords()) {
    if (r.typeName === 'shape') {
      const s = r as TLShape;
      shapes.set(s.id as string, s);
    } else if (r.typeName === 'asset') {
      const a = r as TLAsset;
      assets.set(a.id as string, a);
    }
  }

  const editingId = editor.getEditingShapeId() as string | null;
  const arrowBindings = new Map<string, ArrowBindingPair>();
  // `canon()` of each existing shape decoded back to the simplified model, the same
  // canonical equality the old reconcile loop used to decide "changed". A shape that
  // doesn't decode (an un-modelable type) is left out, so the planner reads
  // `undefined` and treats it as changed (matching the old `!cur` branch).
  const canonical = new Map<string, string>();
  for (const shape of shapes.values()) {
    if (shape.type === 'arrow') {
      const b = getArrowBindings(editor, shape as TLArrowShape);
      arrowBindings.set(shape.id as string, {
        start: b.start ? { id: b.start.id as string, toId: b.start.toId as string } : undefined,
        end: b.end ? { id: b.end.id as string, toId: b.end.toId as string } : undefined,
      });
    }
    const cur = fromTldrawShape(editor, shape);
    if (cur) canonical.set(shape.id as string, canon(cur));
  }

  return {
    shapes,
    assets,
    arrowBindings,
    editingId,
    // While the human is pointing/dragging/text-editing, the shapes they touch are
    // mid-flight; the planner holds those (no update/delete) to avoid snap-back.
    interacting: editor.inputs.isDragging || editor.inputs.isPointing || editingId != null,
    selectedIds: new Set(editor.getSelectedShapeIds() as unknown as string[]),
    canonical,
  };
}

// The planner builds shape partials with a passthrough text encoder so it stays
// DOM-free (it must never import tldraw's `toRichText`). The real encoder is applied
// HERE, at apply time: a partial whose `richText` arrived as a raw plain string
// becomes tldraw rich text. Partials with no string `richText` pass through untouched.
const encodeRichText = (partial: TLShapePartial): TLShapePartial => {
  const props = (partial as { props?: Record<string, unknown> }).props;
  if (props && typeof props.richText === 'string') {
    return { ...partial, props: { ...props, richText: toRichText(props.richText) } } as TLShapePartial;
  }
  return partial;
};

// Apply an ordered plan to the editor: one tldraw call per op kind, no branching or
// diffing; the planner already decided every op and emitted them in apply order.
function applyOps(editor: Editor, ops: ReconcileOp[]): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'assetCreate':
        editor.createAssets(op.assets);
        break;
      case 'assetUpdate':
        editor.updateAssets(op.assets);
        break;
      case 'shapeCreate':
        editor.createShapes(op.partials.map(encodeRichText));
        break;
      case 'shapeUpdate':
        editor.updateShapes(op.partials.map(encodeRichText));
        break;
      case 'shapeDelete':
        editor.deleteShapes(op.ids);
        break;
      case 'bindingDelete':
        editor.deleteBindings(op.ids);
        break;
      case 'bindingCreate':
        editor.createBindings(op.bindings);
        break;
    }
  }
}

const API = '/api';

export function wireSync(editor: Editor): () => void {
  let lastVersion = -1;
  // Ids we've ever seen on the server. We only ever DELETE a local shape if the
  // server once had it and now dropped it, never a brand-new local shape that
  // hasn't round-tripped yet. The delete guard itself lives in the planner;
  // reconcile keeps this set current by marking every id the server sends each
  // accepted frame.
  const mirroredShapes = new Set<string>();

  // --- remote -> editor ---
  function reconcile(state: CanvasState) {
    const snapshot = snapshotEditor(editor);
    const { ops, nextVersion } = planReconcile({
      remote: state,
      lastVersion,
      snapshot,
      mirroredShapes,
    });
    // An ignored echo (version <= watermark) plans nothing and leaves the watermark
    // put: nothing to apply, nothing to mirror.
    if (ops.length === 0 && nextVersion === lastVersion) return;
    editor.store.mergeRemoteChanges(() => applyOps(editor, ops));
    lastVersion = nextVersion;
    // Mark EVERY shape the server sent as mirrored, not just the ones created this
    // frame: a shape authored locally and merely echoed back is already present here,
    // so it never appears as a create, yet it must still be deletable when another
    // client drops it. Only a mirrored id is ever deleted locally.
    for (const s of state.shapes) mirroredShapes.add(s.id);
  }

  // The agent's view_canvas tool asks for a PNG; render it via tldraw and post back.
  const onScreenshot = async (e: MessageEvent) => {
    let id: string;
    try {
      id = (JSON.parse(e.data) as { id: string }).id;
    } catch {
      return;
    }
    const reply = (url: string | null) =>
      fetch(`${API}/canvas/screenshot`, {
        method: 'POST',
        headers: withCanvasHeader({ 'content-type': 'application/json' }),
        body: JSON.stringify({ id, url }),
      }).catch(() => {});
    try {
      const ids = [...editor.getCurrentPageShapeIds()];
      if (ids.length === 0) return void reply(null); // nothing to show
      const { url } = await editor.toImageDataUrl(ids, { format: 'png', background: true, padding: 24 });
      await reply(url);
    } catch {
      await reply(null);
    }
  };
  // Canvas inbound stream, wrapped in open/close so the idle gate (src/idle.ts) can drop
  // it when the tab is hidden — an always-open EventSource auto-reconnects, which would
  // re-wake a slept CF container.
  let es: EventSource | null = null;
  const openCanvasStream = (): void => {
    if (es) return;
    es = new EventSource(withCanvasParam(`${API}/canvas/stream`));
    // A freshly (re)established SSE connection means the bridge may have restarted
    // and reset its monotonic version counter (it does on every server-code reload).
    // Drop our high-water mark so the next primed frame is accepted as authoritative;
    // otherwise we'd ignore every update from the restarted bridge — its versions now
    // being lower than ours — and silently drift out of sync (a clear, an agent edit,
    // anything). onopen fires on the initial connect and on each auto-reconnect.
    es.onopen = () => {
      lastVersion = -1;
    };
    es.onmessage = (e) => {
      try {
        reconcile(JSON.parse(e.data) as CanvasState);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener('screenshot', (e) => void onScreenshot(e as MessageEvent));
  };
  const closeCanvasStream = (): void => {
    es?.close();
    es = null;
  };
  openCanvasStream();
  const unregisterIdle = registerStream({ open: openCanvasStream, close: closeCanvasStream });

  // --- editor -> remote (debounced) ---
  const pendingUpsert = new Map<string, CanvasShape>();
  const pendingDelete = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    // Defer the whole send while the user is actively dragging/pointing. On a
    // high-latency link (e.g. the deployed container proxy, ~1s/round-trip) a
    // sustained drag would otherwise fire a POST every 80ms; each one's echo
    // arrives ~1s late, AFTER pointer-up, and replays a stale position — the
    // shape visibly snaps back and forth until it catches up. Collapsing to a
    // single send right after the interaction ends fixes both the request flood
    // and the bounce (locally this is a no-op: localhost round-trips in ~ms).
    // ...or while a shape is being text-edited. Typing in a note/text/geo label
    // fires a store change per keystroke; without this each ~80ms tick POSTs a full
    // shape upsert and its late echo snaps the caret. Hold until the edit ends
    // (blur/escape), then send once — same collapse as a drag.
    if (editor.inputs.isDragging || editor.inputs.isPointing || editor.getEditingShapeId()) {
      timer = setTimeout(flush, 80);
      return;
    }
    timer = null;
    // Re-read pending arrows from the live editor before sending. A binding added
    // mid-interaction (e.g. dropping an arrow onto a just-created shape) can land
    // in the store a tick after the change event that captured the arrow, so the
    // queued snapshot may still say "no binding". Re-reading now — after the 80ms
    // debounce, with the binding index settled — captures the final terminals, so
    // we never push end=None for a link that actually exists (which the reconcile
    // would otherwise treat as an unbind and delete).
    for (const [id, s] of pendingUpsert) {
      if (s.type !== 'arrow') continue;
      const sh = editor.getShape(id as TLShapeId);
      if (sh && sh.type === 'arrow') {
        const fresh = fromTldrawShape(editor, sh);
        if (fresh) pendingUpsert.set(id, fresh);
      }
    }
    const ups = [...pendingUpsert.values()];
    const dels = [...pendingDelete];
    pendingUpsert.clear();
    pendingDelete.clear();
    try {
      if (ups.length) {
        await fetch(`${API}/canvas/shapes`, {
          method: 'POST',
          headers: withCanvasHeader({ 'content-type': 'application/json' }),
          body: JSON.stringify({ shapes: ups }),
        });
      }
      if (dels.length) {
        await fetch(`${API}/canvas/delete`, {
          method: 'POST',
          headers: withCanvasHeader({ 'content-type': 'application/json' }),
          body: JSON.stringify({ ids: dels }),
        });
      }
    } catch {
      /* bridge offline; next change retries */
    }
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 80);
  };

  // A human-created/edited/removed binding doesn't change the arrow shape record
  // itself, so re-serialize and push the arrow it belongs to (fromId).
  const pushArrowFromBinding = (rec: unknown) => {
    const fromId = (rec as { fromId?: unknown }).fromId;
    if (typeof fromId !== 'string') return;
    const sh = editor.getShape(fromId as TLShapeId);
    if (!sh || sh.type !== 'arrow') return; // arrow gone -> its own removed event handles it
    const s = fromTldrawShape(editor, sh);
    if (s) {
      pendingUpsert.set(s.id, s);
      pendingDelete.delete(s.id);
    }
  };

  // Queue a shape for upload. A freshly pasted IMAGE is special: tldraw populates
  // the asset's src a tick AFTER creating the shape, so the first change event sees
  // an empty src. Pushing that empty src would make the bridge (and reconcile)
  // repoint the shape at a pixel-less asset — a broken box. So for an image with no
  // src yet, don't push; poll the asset briefly and push once the src lands.
  const queueShape = (shape: Parameters<typeof fromTldrawShape>[1]) => {
    const s = fromTldrawShape(editor, shape);
    if (!s) return;
    if (s.type === 'image' && !s.src) {
      pollImageSrc(s.id);
      return;
    }
    pendingUpsert.set(s.id, s);
    pendingDelete.delete(s.id);
  };

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  function pollImageSrc(id: string, attempt = 0): void {
    if (attempt >= 20) return; // ~4s; give up rather than push an empty src
    pollTimer = setTimeout(() => {
      const sh = editor.getShape(id as TLShapeId);
      if (!sh || sh.type !== 'image') return; // deleted or replaced
      const s = fromTldrawShape(editor, sh);
      if (s && s.type === 'image' && s.src) {
        pendingUpsert.set(s.id, s);
        pendingDelete.delete(s.id);
        schedule();
        return;
      }
      pollImageSrc(id, attempt + 1);
    }, 200);
  }

  const unlisten = editor.store.listen(
    (entry) => {
      const { added, updated, removed } = entry.changes;
      for (const rec of Object.values(added)) {
        if (rec.typeName === 'binding') {
          pushArrowFromBinding(rec);
          continue;
        }
        if (rec.typeName !== 'shape') continue;
        queueShape(rec);
      }
      for (const [, next] of Object.values(updated)) {
        if (next.typeName === 'binding') {
          pushArrowFromBinding(next);
          continue;
        }
        if (next.typeName !== 'shape') continue;
        queueShape(next);
      }
      for (const rec of Object.values(removed)) {
        if (rec.typeName === 'binding') {
          pushArrowFromBinding(rec);
          continue;
        }
        if (rec.typeName !== 'shape') continue;
        pendingDelete.add(rec.id);
        pendingUpsert.delete(rec.id);
      }
      if (pendingUpsert.size || pendingDelete.size) schedule();
    },
    { source: 'user', scope: 'document' },
  );

  return () => {
    unregisterIdle();
    closeCanvasStream();
    unlisten();
    if (timer) clearTimeout(timer);
    if (pollTimer) clearTimeout(pollTimer);
  };
}
