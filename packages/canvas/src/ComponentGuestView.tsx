// Component-guest mode (PRD #221): a share link scoped to ONE placed component renders
// that shape's component fullscreen — no tldraw, no other shapes' UI, no chat.
//
// Since ADR-0019 / #294 the state arrives over a READ-ONLY connection to the canvas's
// TLSocketRoom, the same room members edit — so a member's change appears here live. The
// old SSE stream and the `POST /api/canvas/shapes` write-back are both gone with the old
// wire. Read-only is enforced at the Durable Object (`worker/sync-api.ts` stamps it,
// sync-core drops a read-only session's document diffs); this file never had, and now
// cannot have, a write path to the room.
//
// CONSEQUENCE, deliberate: a guest's `setData` is LOCAL to their tab. Under the old wire
// it POSTed the whole shape back and members saw guest edits. A share link is a
// capability to read one canvas, so that write-back does not survive the migration —
// interactive components still respond to a guest's clicks, they just don't persist.
//
// There is no tldraw Editor here; a tiny adapter satisfies the slice of the Editor
// surface ComponentHost actually touches (getShape / updateShape / store.listen).

import { useSync } from '@tldraw/sync';
import * as React from 'react';

import { createCanvasAssetStore, syncUri } from './canvas-sync';
import { ComponentHost } from './ComponentShape';
import { createCanvasTLSchema } from './tl-schema';

/** The slice of tldraw's `TLStore` this view reads — narrower than the real type on
 *  purpose (CLAUDE.md §2), so the adapter is testable against a plain object and so the
 *  absence of any mutating call is visible in the type itself. */
export interface GuestRoomStore {
  get(id: string): ComponentRecord | undefined;
  listen(cb: () => void, opts?: unknown): () => void;
}

/** The one record this whole surface is about: the shared component shape. */
interface ComponentRecord {
  id: string;
  type: string;
  props: { module: string; data: Record<string, unknown>; rev: number; dataSource?: unknown };
}

type EditorShape = { id: string; type: string; props: Record<string, unknown>; meta: Record<string, unknown> };

interface GuestShapeStore {
  editor: {
    getShape(id: never): EditorShape | undefined;
    updateShape(p: { id: string; props?: { data?: Record<string, unknown> }; meta?: Record<string, unknown> }): void;
    store: { listen(cb: () => void, opts?: unknown): () => void };
  };
  getShape(): EditorShape | undefined;
}

/**
 * The Editor-shaped adapter over the ONE shape a component-scoped link shares.
 *
 * Reads come from the room record and are re-read on every room change, so the room stays
 * authoritative — a member's edit overwrites whatever the guest's own `setData` put there.
 * Writes go nowhere but this tab: `data` is held as a local overlay (dropped the moment
 * the room speaks again) and `meta` (load status) is purely local, as it always was.
 */
export function createGuestShapeStore(room: GuestRoomStore, shapeId: string): GuestShapeStore {
  let meta: Record<string, unknown> = {};
  let localData: Record<string, unknown> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };

  // Reference-stable snapshot for useSyncExternalStore: rebuilt only when something
  // actually changed, never on read.
  let snapshot: EditorShape | undefined;
  const rebuild = () => {
    const rec = room.get(shapeId);
    snapshot =
      rec && rec.type === 'component'
        ? {
            id: rec.id,
            type: 'component',
            props: { ...rec.props, data: localData ?? rec.props.data },
            meta,
          }
        : undefined;
  };
  rebuild();
  // A room change is the authority speaking: drop the local overlay and re-read.
  room.listen(() => {
    localData = null;
    rebuild();
    notify();
  }, { scope: 'document' });

  return {
    editor: {
      getShape: () => snapshot,
      updateShape: (p) => {
        if (p.props?.data) localData = p.props.data;
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
    getShape: () => snapshot,
  };
}

/**
 * The guest's connection to the canvas: the same `useSync` room the pad uses, on the same
 * schema, opened with the guest cookie. The Worker refuses the upgrade unless the cookie's
 * share link is live for THIS canvas, and marks the session read-only before the Durable
 * Object is addressed (`worker/sync-api.ts`).
 */
export function ComponentGuestView({ shapeId, canvasId }: { shapeId: string; canvasId: string }) {
  const store = useSync({
    uri: React.useMemo(() => syncUri(window.location.origin, canvasId), [canvasId]),
    assets: React.useMemo(() => createCanvasAssetStore(canvasId), [canvasId]),
    schema: React.useMemo(() => createCanvasTLSchema(), []),
  });
  if (store.status !== 'synced-remote') {
    return <div className="component-guest-empty">{store.status === 'error' ? 'This component is no longer available.' : 'loading…'}</div>;
  }
  // The one cast in this file: tldraw's `TLStore` is structurally what `GuestRoomStore`
  // describes, but its `get` is generic over branded record ids.
  return <GuestComponent store={store.store as unknown as GuestRoomStore} shapeId={shapeId} />;
}

// Subscribed to the adapter so a member's edit re-renders the fullscreen component with
// fresh props. `getShape` is reference-stable until something changes.
export function GuestComponent({ store, shapeId }: { store: GuestRoomStore; shapeId: string }) {
  const adapter = React.useMemo(() => createGuestShapeStore(store, shapeId), [store, shapeId]);
  const shape = React.useSyncExternalStore(
    React.useCallback((cb) => adapter.editor.store.listen(cb), [adapter]),
    () => adapter.getShape(),
  );
  if (!shape) return <div className="component-guest-empty">This component is no longer available.</div>;
  const props = shape.props as unknown as ComponentRecord['props'];
  return (
    <div className="component-fullscreen component-guest">
      <div className="component-fullscreen-head">
        <span className="component-fullscreen-title">{props.module}</span>
      </div>
      <div className="component-fullscreen-body">
        <ComponentHost
          shapeId={shapeId}
          editor={adapter.editor as never}
          module={props.module}
          data={props.data}
          rev={props.rev}
          dataSource={props.dataSource as never}
        />
      </div>
    </div>
  );
}
