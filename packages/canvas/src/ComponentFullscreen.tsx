// Fullscreen view of a placed component: the ⛶ button on a component card expands it
// over the whole canvas viewport. Same module-level-singleton bus pattern as agent-link
// (the shape has no App access; App owns the editor + overlay state). The overlay renders
// a SECOND ComponentHost against the same shape — data edits made fullscreen persist via
// the same setData path and the card on the canvas stays live underneath.

import * as React from 'react';

import { activeCanvasId } from './active-canvas';
import { ComponentHost } from './ComponentShape';
import { useGuestScope } from '../shared/guest-scope';

/** The minimal editor surface the overlay needs — narrowed for testability. */
export interface OverlayEditor {
  getShape(id: never): { type?: string; props?: unknown } | undefined;
  store: { listen(cb: () => void, opts: { scope: 'document' }): () => void };
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
  shapeId: string;
  onClose: () => void;
}) {
  // Live view of the shape record: tldraw records are reference-stable until changed,
  // so getShape doubles as the snapshot. A rev bump or data write re-renders fullscreen.
  const shape = React.useSyncExternalStore(
    React.useCallback((cb) => editor.store.listen(cb, { scope: 'document' }), [editor]),
    () => editor.getShape(shapeId as never),
  );

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

  // Shape deleted (possibly by a remote peer over sync) while expanded: close.
  React.useEffect(() => {
    if (!shape || shape.type !== 'component') onClose();
  }, [shape, onClose]);
  if (!shape || shape.type !== 'component') return null;

  const props = shape.props as { module: string; data: Record<string, unknown>; rev: number };
  return (
    <div className="component-fullscreen">
      <div className="component-fullscreen-head">
        <span className="component-fullscreen-title">{props.module}</span>
        <ShareControls shapeId={shapeId} />
        <button type="button" className="component-fullscreen-close" title="Close fullscreen (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="component-fullscreen-body">
        <ComponentHost
          shapeId={shapeId}
          editor={editor as never}
          module={props.module}
          data={props.data}
          rev={props.rev}
        />
      </div>
    </div>
  );
}
