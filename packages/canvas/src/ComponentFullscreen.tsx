// Fullscreen view of a placed component: the ⛶ button on a component card expands it
// over the whole canvas viewport. Same module-level-singleton bus pattern as agent-link
// (the shape has no App access; App owns the editor + overlay state). The overlay renders
// a SECOND ComponentHost against the same shape — data edits made fullscreen persist via
// the same setData path and the card on the canvas stays live underneath.

import * as React from 'react';

import { ComponentHost } from './ComponentShape';

/** The minimal editor surface the overlay needs — narrowed for testability. */
export interface OverlayEditor {
  getShape(id: never): { type?: string; props?: unknown } | undefined;
  store: { listen(cb: () => void, opts: { scope: 'document' }): () => void };
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
