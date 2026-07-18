// The canvas side panel: one docked right column owning ALL canvas controls —
// tldraw's toolbar / style panel / menu / zoom nav (portaled in from the Tldraw
// tree so their hooks keep working), plus the component palette and the list of
// component instances placed on this board (click → zoom-to + select).
// Members only: guests keep tldraw's default floating chrome.

import * as React from 'react';
import { useValue, type Editor, type TLShapeId } from 'tldraw';


const OPEN_KEY = 'agent-canvas:side-panel';

export function loadPanelOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function savePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/** Label the placed component instances: the module name, numbered ("Kanban 2")
 *  when the same module appears more than once, in page order. */
export function instanceLabels(instances: Array<{ id: string; module: string }>): Array<{ id: string; label: string }> {
  const totals = new Map<string, number>();
  for (const i of instances) totals.set(i.module, (totals.get(i.module) ?? 0) + 1);
  const seen = new Map<string, number>();
  return instances.map((i) => {
    const n = (seen.get(i.module) ?? 0) + 1;
    seen.set(i.module, n);
    return { id: i.id, label: (totals.get(i.module) ?? 1) > 1 ? `${i.module} ${n}` : i.module };
  });
}

/** The placed-instances section: live list of `component` shapes on the current
 *  page; clicking one selects it and zooms the camera to its bounds. */
function InstanceList({ editor }: { editor: Editor }) {
  const instances = useValue(
    'component-instances',
    () =>
      editor
        .getCurrentPageShapes()
        .filter((s) => s.type === 'component')
        .map((s) => ({ id: s.id as string, module: (s.props as { module?: string }).module ?? '?' })),
    [editor],
  );
  const focus = (id: string) => {
    const bounds = editor.getShapePageBounds(id as TLShapeId);
    if (!bounds) return;
    editor.select(id as TLShapeId);
    editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 300 } });
  };
  const labeled = instanceLabels(instances);
  return (
    <div className="instance-list">
      {labeled.length === 0 && <div className="instance-list-empty">Nothing placed yet.</div>}
      {labeled.map((i) => (
        <button key={i.id} type="button" className="instance-list-row" title="Zoom to this instance" onClick={() => focus(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export type PanelSlots = { menu: HTMLElement | null; style: HTMLElement | null; toolbar: HTMLElement | null; nav: HTMLElement | null };

export function SidePanel({
  editor,
  onSlots,
  onClose,
  onAddComponent,
}: {
  editor: Editor | null;
  onSlots: (slots: Partial<PanelSlots>) => void;
  onClose: () => void;
  onAddComponent: () => void;
}) {
  // Stable ref callbacks (memoized per panel mount): a new function identity each
  // render makes React detach (null) + reattach every render, which loops setState.
  const slots = React.useRef<Partial<Record<keyof PanelSlots, (el: HTMLElement | null) => void>>>({});
  const slot = (name: keyof PanelSlots) => (slots.current[name] ??= (el) => onSlots({ [name]: el }));
  return (
    <aside className="side-panel">
      <div className="side-panel-head">
        <span className="side-panel-title">Canvas</span>
        <button type="button" className="side-panel-collapse" title="Collapse the panel" onClick={onClose}>
          »
        </button>
      </div>
      <details className="side-panel-section side-panel-controls" open>
        <summary>Controls</summary>
        <div className="side-panel-slot side-panel-toolbar" ref={slot('toolbar')} />
        <div className="side-panel-slot side-panel-style" ref={slot('style')} />
      </details>
      <details className="side-panel-section" open>
        <summary>On this board</summary>
        <button type="button" className="side-panel-add" onClick={onAddComponent}>
          ＋ Component
        </button>
        {editor && <InstanceList editor={editor} />}
      </details>
      <div className="side-panel-slot side-panel-nav" ref={slot('nav')} />
    </aside>
  );
}
