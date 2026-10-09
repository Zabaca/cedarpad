// Fullscreen view of the placed components on a canvas page: the ⛶ button on a component
// card (or on a side-panel list row) expands one over the whole canvas viewport, and a rail
// down the left edge browses the rest — the same list the side panel shows, so order and
// labels can't disagree. Same module-level-singleton bus pattern as agent-link (the shape
// has no App access; App owns the editor + overlay state). The overlay renders a SECOND
// ComponentHost against the same shape — data edits made fullscreen persist via the same
// setData path and the card on the canvas stays live underneath.

import * as React from 'react';

import { activeCanvasId } from './active-canvas';
import { ComponentInstanceList, instanceLabels, readComponentInstances } from './ComponentInstanceList';
import { ComponentHost } from './ComponentShape';
import { useGuestScope } from '../shared/guest-scope';
import type { DataSource } from '../shared/data-source';

/** The minimal editor surface the overlay needs — narrowed for testability. The four
 *  page/camera operations are what the rail added; nothing wider is imported, so the
 *  suite still drives this file with a plain object. */
export interface OverlayEditor {
  getShape(id: never): { type?: string; props?: unknown } | undefined;
  getCurrentPageShapes(): ReadonlyArray<{ id: string; type: string; props?: unknown }>;
  getShapePageBounds(id: never): { x: number; y: number; w: number; h: number } | undefined;
  select(id: never): void;
  zoomToBounds(bounds: { x: number; y: number; w: number; h: number }, opts?: { targetZoom?: number }): void;
  store: { listen(cb: () => void, opts: { scope: 'document' }): () => void };
}

const RAIL_KEY = 'agent-canvas:fullscreen-rail';

/** The rail is open until the member collapses it — a collapsed rail would make
 *  fullscreen look exactly as it did before the feature existed. */
export function loadRailOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveRailOpen(open: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/** Where navigation lands when the viewed shape leaves the list: the entry that took its
 *  place, or the last one if it was the tail. Null once nothing is left to show. */
function advanceTarget(ids: ReadonlyArray<string>, goneIndex: number): string | null {
  if (ids.length === 0) return null;
  return ids[Math.min(goneIndex, ids.length - 1)] ?? null;
}

// PRD #221: mint/copy/revoke component-scoped guest links from the fullscreen header —
// "this is exactly what they'll see". Members only (a guest's edge session can't reach
// the share-links API anyway; don't offer it). Same edge API as the Shell's canvas panel,
// with `shapeId` narrowing the link to this placed instance.
function ShareControls({ shapeId }: { shapeId: string }) {
  const guest = useGuestScope();
  const [open, setOpen] = React.useState(false);
  const [links, setLinks] = React.useState<Array<{ id: string; shapeId: string | null; revokedAt: number | null }>>([]);
  const canvasId = activeCanvasId();

  const load = React.useCallback(async () => {
    const r = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/share-links`, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) return;
    const { links: all } = (await r.json()) as { links: Array<{ id: string; shapeId: string | null; revokedAt: number | null }> };
    setLinks(all.filter((l) => l.shapeId === shapeId && !l.revokedAt));
  }, [canvasId, shapeId]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (guest) return null;

  const mint = async () => {
    await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/share-links`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shapeId }),
    }).catch(() => null);
    void load();
  };
  const revoke = async (id: string) => {
    await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/share-links/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => null);
    void load();
  };

  return (
    <>
      <button type="button" className="component-share-toggle" title="Share this component with a guest link" onClick={() => setOpen((o) => !o)}>
        Share
      </button>
      {open && (
        <div className="component-share-panel">
          {links.map((l) => (
            <div key={l.id} className="component-share-row">
              <span className="component-share-url">{`${window.location.origin}/share/${l.id}`}</span>
              <button type="button" title="Copy link" onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/share/${l.id}`)}>
                copy
              </button>
              <button type="button" title="Revoke this link" onClick={() => void revoke(l.id)}>
                revoke
              </button>
            </div>
          ))}
          <button type="button" className="component-share-new" onClick={() => void mint()}>
            + New guest link
          </button>
        </div>
      )}
    </>
  );
}

export function ComponentFullscreenOverlay({
  editor,
  shapeId,
  onClose,
}: {
  editor: OverlayEditor;
  /** Where fullscreen opened. Navigation moves on from here; the prop is the entry point,
   *  not the live answer, so the rail's own cursor takes over once it exists. */
  shapeId: string;
  onClose: () => void;
}) {
  // Live view of the document: tldraw records are reference-stable until changed, so a
  // store change is the signal for both the viewed shape AND the rail's list. One
  // subscription serves both — the rail deliberately doesn't reach for tldraw's reactive
  // hook, which the plain-object stub in this file's tests can't provide.
  // A counter, not the viewed record: adding a DIFFERENT shape leaves this shape's record
  // reference-stable, and the rail has to notice that too.
  const versionRef = React.useRef(0);
  const version = React.useSyncExternalStore(
    React.useCallback(
      (cb) =>
        editor.store.listen(
          () => {
            versionRef.current++;
            cb();
          },
          { scope: 'document' },
        ),
      [editor],
    ),
    () => versionRef.current,
  );
  const instances = React.useMemo(() => instanceLabels(readComponentInstances(editor)), [editor, version]);

  const [viewedId, setViewedId] = React.useState(shapeId);
  const [railOpen, setRailOpen] = React.useState(loadRailOpen);

  // Select + zoom the canvas underneath every switch, so Escape lands the member on
  // whatever they read last. Instant: an animation would be running against a viewport
  // nobody can see.
  const goTo = React.useCallback(
    (id: string) => {
      setViewedId(id);
      const bounds = editor.getShapePageBounds(id as never);
      if (!bounds) return;
      editor.select(id as never);
      editor.zoomToBounds(bounds, { targetZoom: 1 });
    },
    [editor],
  );

  const index = instances.findIndex((i) => i.id === viewedId);
  const step = (delta: number) => {
    if (instances.length === 0) return;
    // Unconditional wrap: neither arrow is ever a dead control.
    const next = instances[(index + delta + instances.length) % instances.length];
    if (next) goTo(next.id);
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  // The viewed component left the page — deleted here or by a remote peer over sync.
  // With a rail on screen, closing the whole overlay over one of ten reads as a bug, so
  // advance instead; close only when there is nothing left to show.
  const goneIndex = React.useRef(0);
  if (index >= 0) goneIndex.current = index;
  React.useEffect(() => {
    if (index >= 0) return;
    const target = advanceTarget(
      instances.map((i) => i.id),
      goneIndex.current,
    );
    if (target) goTo(target);
    else onClose();
  }, [index, instances, goTo, onClose]);

  const shape = editor.getShape(viewedId as never);
  if (!shape || shape.type !== 'component') return null;

  const props = shape.props as { module: string; data: Record<string, unknown>; rev: number; dataSource?: DataSource | null };
  const label = instances[index]?.label ?? props.module;
  // One component is nothing to browse: no rail, no arrows, and fullscreen looks exactly
  // as it did before this existed. Both appear the moment a second one lands.
  const navigable = instances.length > 1;

  const toggleRail = () => {
    setRailOpen((open) => {
      saveRailOpen(!open);
      return !open;
    });
  };

  return (
    <div className="component-fullscreen">
      <div className="component-fullscreen-head">
        {navigable && (
          <button
            type="button"
            className="component-fullscreen-rail-toggle"
            title={railOpen ? 'Hide the component list' : 'Show the component list'}
            onClick={toggleRail}
          >
            ☰
          </button>
        )}
        <span className="component-fullscreen-title">{label}</span>
        {navigable && (
          <>
            <button type="button" className="component-fullscreen-prev" title="Previous component" onClick={() => step(-1)}>
              ‹
            </button>
            <button type="button" className="component-fullscreen-next" title="Next component" onClick={() => step(1)}>
              ›
            </button>
          </>
        )}
        {/* Keyed by the viewed shape: a link minted here belongs to the component the
            header names, never the one before it. */}
        <ShareControls key={viewedId} shapeId={viewedId} />
        <button type="button" className="component-fullscreen-close" title="Close fullscreen (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="component-fullscreen-main">
        {navigable && railOpen && (
          <div className="component-fullscreen-rail">
            {/* No ⛶ on these rows — you are already fullscreen. */}
            <ComponentInstanceList items={instances} activeId={viewedId} onPrimary={goTo} primaryTitle="View this component" />
          </div>
        )}
        <div className="component-fullscreen-body">
          <ComponentHost
          unguarded
            key={viewedId}
            shapeId={viewedId}
            editor={editor as never}
            module={props.module}
            data={props.data}
            rev={props.rev}
            dataSource={props.dataSource ?? undefined}
          />
        </div>
      </div>
    </div>
  );
}
