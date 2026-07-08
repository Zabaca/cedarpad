import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppView } from './App';
import { activeCanvasId, DEFAULT_CANVAS_ID } from './active-canvas';

// A custom left-hand nav, rendered as a SIBLING of <Tldraw> (outside tldraw's
// React context). It needs no editor: the hierarchy is Workspace > Canvases >
// Canvas, and every canvas operation goes through /api/canvases at the edge.
//
// Layout follows the cedarpad CedarShell mock (see DESIGN.md): a thin icon rail
// (workspace mark + Canvases section + operator avatar) beside the panel, which
// lists the workspace's canvases.

const WORKSPACE_NAME = 'Zabaca';

function IconCanvases() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}

// A small node-graph glyph for web-poc (the Problem/Solution knowledge graph).
function IconWebPoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M8 6h8M7.4 8l3.4 7.8M16.6 8l-3.4 7.8" />
    </svg>
  );
}

export function LeftPanel({
  activeApp,
  onSelectApp,
}: {
  activeApp: AppView;
  onSelectApp: (app: AppView) => void;
}) {
  // The Canvas app index (ADR-0007, #54): the workspace's canvases from /api/canvases
  // (edge, scoped to the active workspace via cs_workspace). Switching navigates to
  // /w/:ws/canvas/:id, which pins cs_canvas and reloads onto that canvas. The active
  // one is whatever cs_canvas currently selects (default when unset).
  type CanvasEntry = { id: string; name: string };
  const [wsId, setWsId] = useState<string>(DEFAULT_CANVAS_ID);
  const [canvases, setCanvases] = useState<CanvasEntry[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [cvEditingId, setCvEditingId] = useState<string | null>(null);
  const [cvDraft, setCvDraft] = useState('');
  const activeCanvas = activeCanvasId();

  const loadCanvases = useCallback(async () => {
    try {
      const r = await fetch('/api/canvases', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = (await r.json()) as { workspaceId: string; canvases: CanvasEntry[] };
      setWsId(d.workspaceId);
      setCanvases(d.canvases);
    } catch {
      /* bridge/edge offline — leave the list as-is */
    }
  }, []);
  useEffect(() => {
    void loadCanvases();
  }, [loadCanvases]);

  // The full switch list always offers the legacy Default canvas (no registry row) so
  // you can return to it; registry canvases follow.
  const canvasList: CanvasEntry[] = [{ id: DEFAULT_CANVAS_ID, name: 'Default' }, ...canvases];

  const switchCanvas = (id: string) => {
    if (id === activeCanvas) return;
    setSwitching(id);
    window.location.href = `/w/${encodeURIComponent(wsId)}/canvas/${encodeURIComponent(id)}`;
  };

  const createCanvas = async () => {
    const name = `Canvas ${canvases.length + 1}`;
    const r = await fetch('/api/canvases', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) return;
    const c = (await r.json()) as CanvasEntry;
    setSwitching(c.id);
    window.location.href = `/w/${encodeURIComponent(wsId)}/canvas/${encodeURIComponent(c.id)}`;
  };

  const commitCanvasRename = async () => {
    if (!cvEditingId) return;
    const name = cvDraft.trim();
    const id = cvEditingId;
    setCvEditingId(null);
    if (!name) return;
    await fetch(`/api/canvases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    void loadCanvases();
  };

  const deleteCanvas = async (id: string) => {
    await fetch(`/api/canvases/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    void loadCanvases();
  };

  // Workspace switcher popover (the rail's Z). One real workspace today; this is
  // the seam for multi-workspace if the data model ever grows.
  const [wsOpen, setWsOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  // Close the popover on outside-click or Escape. Clicks on the Z button and on
  // popover rows are inside rootRef, so they don't trigger the outside handler.
  useEffect(() => {
    if (!wsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setWsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [wsOpen]);

  return (
    <aside className="left-panel" ref={rootRef}>
      {/* Icon rail: workspace mark, active section, operator avatar pinned bottom. */}
      <nav className="lp-rail" aria-label="Workspace">
        <button
          type="button"
          className={`lp-rail-btn lp-z${wsOpen ? ' active' : ''}`}
          title={`Workspace: ${WORKSPACE_NAME}`}
          aria-haspopup="menu"
          aria-expanded={wsOpen}
          onClick={() => setWsOpen((v) => !v)}
        >
          Z
        </button>
        <button
          type="button"
          className={`lp-rail-btn${activeApp === 'canvas' ? ' active' : ''}`}
          title="Canvases"
          aria-current={activeApp === 'canvas' ? 'page' : undefined}
          onClick={() => onSelectApp('canvas')}
        >
          <IconCanvases />
        </button>
        <button
          type="button"
          className={`lp-rail-btn${activeApp === 'webpoc' ? ' active' : ''}`}
          title="Web POC — Problem/Solution Intelligence"
          aria-current={activeApp === 'webpoc' ? 'page' : undefined}
          onClick={() => onSelectApp('webpoc')}
        >
          <IconWebPoc />
        </button>
        <div className="lp-rail-bottom">
          <div className="lp-avatar" title="James">J</div>
        </div>
      </nav>

      {/* Panel body: hidden for web-poc (the rail alone — see .app--webpoc), else the
          workspace's canvas list. */}
      {activeApp === 'webpoc' ? null : (
        <div className="lp-body">
          <div className="left-panel-head">
            <span className="left-panel-title">Canvases</span>
            <button type="button" className="left-panel-add" onClick={createCanvas} title="Create a new canvas">
              +
            </button>
          </div>
          <ul className="page-list">
            {canvasList.map((c) => {
              const active = c.id === activeCanvas;
              const isSwitching = switching === c.id;
              return (
                <li
                  key={c.id}
                  className={`page-row${active ? ' active' : ''}`}
                  onClick={() => switchCanvas(c.id)}
                >
                  {cvEditingId === c.id ? (
                    <input
                      className="page-rename"
                      value={cvDraft}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setCvDraft(e.target.value)}
                      onBlur={commitCanvasRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitCanvasRename();
                        else if (e.key === 'Escape') setCvEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="page-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        // The legacy Default canvas has no registry row, so it can't be renamed.
                        if (c.id === DEFAULT_CANVAS_ID) return;
                        setCvEditingId(c.id);
                        setCvDraft(c.name);
                      }}
                    >
                      {c.name}
                      {isSwitching && <span className="lp-crumb-sep"> · waking…</span>}
                    </span>
                  )}
                  {c.id !== DEFAULT_CANVAS_ID && !active && (
                    <button
                      type="button"
                      className="page-del"
                      title="Delete canvas"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteCanvas(c.id);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Workspace switcher popover: the single real workspace. New-workspace lands
          when/if a workspace entity exists, so it's intentionally absent today. */}
      {wsOpen && (
        <div className="lp-ws-popover" role="menu">
          <div className="lp-ws-label">Workspaces</div>
          <div className="lp-ws-row active" role="menuitemradio" aria-checked="true">
            <span className="lp-ws-glyph">Z</span>
            <span className="lp-ws-name">{WORKSPACE_NAME}</span>
            <span className="lp-ws-check" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7" />
              </svg>
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
