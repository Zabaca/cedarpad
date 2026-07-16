// Component-guest mode (PRD #221): a share link scoped to ONE placed component renders
// that shape's component fullscreen — no tldraw, no other shapes' UI, no chat. Interactive:
// setData persists to the shape over the same bridge writes the canvas uses, so members see
// guest edits live and vice versa (the SSE stream updates this view).
//
// There is no tldraw Editor here; a tiny adapter satisfies the slice of the Editor surface
// ComponentHost actually touches (getShape / updateShape / store.listen), backed by the
// bridge's simplified canvas model instead of a tldraw store.

import * as React from 'react';

import { withCanvasHeader, withCanvasParam } from './active-canvas';
import { ComponentHost } from './ComponentShape';
import type { ComponentShape } from './shapes';

interface GuestShapeStore {
  editor: {
    getShape(id: never): { id: string; type: string; props: Record<string, unknown>; meta: Record<string, unknown> } | undefined;
    updateShape(p: { id: string; props?: { data?: Record<string, unknown> }; meta?: Record<string, unknown> }): void;
    store: { listen(cb: () => void, opts?: unknown): () => void };
  };
  setModel(next: ComponentShape | null): void;
  getModel(): ComponentShape | null;
}

/** The Editor-shaped adapter over one model shape. Data writes POST the full shape back
 * to the bridge (the same upsert route the member pad's sync uses); meta (status) writes
 * stay local — a guest's load lifecycle is nobody else's business. */
export function createGuestShapeStore(initial: ComponentShape): GuestShapeStore {
  let model: ComponentShape | null = initial;
  let meta: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  // Reference-stable snapshot for useSyncExternalStore: rebuild only on change.
  let snapshot: { id: string; type: string; props: Record<string, unknown>; meta: Record<string, unknown> } | undefined;
  const rebuild = () => {
    snapshot = model
      ? {
          id: model.id,
          type: 'component',
          props: { w: model.w, h: model.h, module: model.module, data: model.data, rev: model.rev },
          meta,
        }
      : undefined;
  };
  rebuild();
  return {
    editor: {
      getShape: () => snapshot,
      updateShape: (p) => {
        if (!model) return;
        if (p.props?.data) {
          model = { ...model, data: p.props.data };
          void fetch(withCanvasParam('/api/canvas/shapes'), {
            method: 'POST',
            headers: withCanvasHeader({ 'content-type': 'application/json' }),
            body: JSON.stringify({ shapes: [model] }),
          }).catch(() => {});
        }
        if (p.meta) meta = p.meta;
        rebuild();
        notify();
      },
      store: {
        listen: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    },
    setModel: (next) => {
      model = next;
      rebuild();
      notify();
    },
    getModel: () => model,
  };
}

const findComponent = (state: unknown, shapeId: string): ComponentShape | null => {
  const shapes = (state as { shapes?: Array<{ id: string; type: string }> })?.shapes;
  const hit = shapes?.find((s) => s.id === shapeId && s.type === 'component');
  return (hit as ComponentShape | undefined) ?? null;
};

export function ComponentGuestView({ shapeId }: { shapeId: string }) {
  const [store, setStore] = React.useState<GuestShapeStore | null>(null);
  const [state, setState] = React.useState<'loading' | 'gone' | 'ready'>('loading');

  React.useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let s: GuestShapeStore | null = null;
    void fetch(withCanvasParam('/api/canvas'), { headers: withCanvasHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        if (!alive) return;
        const model = doc ? findComponent(doc, shapeId) : null;
        if (!model) {
          setState('gone');
          return;
        }
        s = createGuestShapeStore(model);
        setStore(s);
        setState('ready');
        // Live updates: the same full-state SSE frames the canvas syncs from, narrowed
        // to this one shape. An echo of our own write is idempotent.
        es = new EventSource(withCanvasParam('/api/canvas/stream'));
        es.onmessage = (e) => {
          try {
            const next = findComponent(JSON.parse((e as MessageEvent).data as string), shapeId);
            if (!next) {
              setState('gone'); // deleted by a member while the guest was viewing
              return;
            }
            const cur = s?.getModel();
            if (JSON.stringify(next) !== JSON.stringify(cur)) s?.setModel(next);
          } catch {
            /* malformed frame: skip */
          }
        };
      })
      .catch(() => alive && setState('gone'));
    return () => {
      alive = false;
      es?.close();
    };
  }, [shapeId]);

  if (state === 'loading') return <div className="component-guest-empty">loading…</div>;
  if (state === 'gone' || !store) return <div className="component-guest-empty">This component is no longer available.</div>;
  return <GuestHost store={store} shapeId={shapeId} />;
}

// Subscribed to the adapter store so remote frames (a member editing the data) re-render
// the fullscreen component with fresh props. getModel is reference-stable until a change.
function GuestHost({ store, shapeId }: { store: GuestShapeStore; shapeId: string }) {
  const model = React.useSyncExternalStore(
    React.useCallback((cb) => store.editor.store.listen(cb), [store]),
    () => store.getModel(),
  );
  if (!model) return <div className="component-guest-empty">This component is no longer available.</div>;
  return (
    <div className="component-fullscreen component-guest">
      <div className="component-fullscreen-head">
        <span className="component-fullscreen-title">{model.module}</span>
      </div>
      <div className="component-fullscreen-body">
        <ComponentHost shapeId={shapeId} editor={store.editor as never} module={model.module} data={model.data} rev={model.rev} />
      </div>
    </div>
  );
}
