// The canvas side panel: one docked right column owning ALL canvas controls —
// tldraw's toolbar / style panel / menu / zoom nav (portaled in from the Tldraw
// tree so their hooks keep working), plus the component palette and the list of
// component instances placed on this board (click → zoom-to + select, ⛶ → fullscreen).
// Members only: guests keep tldraw's default floating chrome.

import * as React from 'react';
import { useValue, type Editor, type TLShapeId } from 'tldraw';
import { activeCanvasId } from './active-canvas';
import { ComponentInstanceList, instanceLabels, readComponentInstances } from './ComponentInstanceList';
import { requestExpand } from './component-expand';
import { HuddleControl } from './huddle';


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

/** The placed-instances section: live list of `component` shapes on the current page.
 *  A row's ordinary click selects it and zooms the camera to its bounds; its ⛶ opens
 *  that component fullscreen through the same expand bus the component card uses. */
function InstanceList({ editor }: { editor: Editor }) {
  const instances = useValue('component-instances', () => readComponentInstances(editor), [editor]);
  const focus = (id: string) => {
    const bounds = editor.getShapePageBounds(id as TLShapeId);
    if (!bounds) return;
    editor.select(id as TLShapeId);
    editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 300 } });
  };
  return <ComponentInstanceList items={instanceLabels(instances)} onPrimary={focus} onExpand={requestExpand} />;
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
        <summary>Huddle</summary>
        <div className="side-panel-huddle">
          <HuddleControl canvasId={activeCanvasId()} className="side-panel-add" />
        </div>
      </details>
      <details className="side-panel-section" open>
        <summary>On this board</summary>
        <div className="side-panel-actions">
          <button type="button" className="side-panel-add" onClick={onAddComponent}>
            ＋ Component
          </button>
        </div>
        {editor && <InstanceList editor={editor} />}
      </details>
      <div className="side-panel-slot side-panel-nav" ref={slot('nav')} />
    </aside>
  );
}
