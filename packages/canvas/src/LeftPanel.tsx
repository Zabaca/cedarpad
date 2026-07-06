import { useEffect, useRef, useState } from 'react';
import { type Editor, PageRecordType, type TLPageId, useValue } from 'tldraw';
import type { AppView } from './App';

// A custom left-hand nav, rendered as a SIBLING of <Tldraw> (outside tldraw's
// React context), so it receives the live `editor` by prop rather than via
// useEditor(). It owns the page list now that tldraw's built-in PageMenu is
// hidden (see App.tsx `components={{ PageMenu: null }}`). Pages already sync as
// CanvasPage records, so create/rename/delete here round-trip through the
// existing sync with no extra wiring.
//
// Layout follows the cedarpad CedarShell mock (see DESIGN.md): a thin icon rail
// (workspace mark + Canvases section + operator avatar) beside the panel, which
// drills Workspace > Canvas > Pages. The backend has only tldraw PAGES — there is
// no workspace/canvas data tier — so the higher tiers are FRONTEND-ONLY and
// honest: one real workspace (Zabaca) and one real canvas (this document). They
// are the seam for a real multi-canvas model later; we don't fake sibling lists,
// because extra canvases would share the single page set until the backend exists.

const WORKSPACE_NAME = 'Zabaca';
const CANVAS_NAME = 'Canvas 1';

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
  editor,
  activeApp,
  onSelectApp,
}: {
  editor: Editor;
  activeApp: AppView;
  onSelectApp: (app: AppView) => void;
}) {
  // Track pages + the current page live. useValue only needs the signal-reading
  // function, so it works fine outside the editor's React context.
  const pages = useValue('pages', () => editor.getPages(), [editor]);
  const currentPageId = useValue('currentPageId', () => editor.getCurrentPageId(), [editor]);

  // Which page (if any) is mid-rename, plus its draft text. Double-click a name
  // to edit; commit on blur/Enter, cancel on Escape.
  const [editingId, setEditingId] = useState<TLPageId | null>(null);
  const [draft, setDraft] = useState('');

  // Panel view: the Canvases section drills canvas-list <-> that canvas's pages.
  const [view, setView] = useState<'canvases' | 'pages'>('pages');

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

  const startRename = (id: TLPageId, name: string) => {
    setEditingId(id);
    setDraft(name);
  };

  const commitRename = () => {
    if (!editingId) return;
    const name = draft.trim();
    // Empty names are meaningless; keep the old one rather than blanking the row.
    if (name) editor.renamePage(editingId, name);
    setEditingId(null);
  };

  const addPage = () => {
    const id = PageRecordType.createId();
    editor.createPage({ id, name: `Page ${pages.length + 1}` });
    editor.setCurrentPage(id);
  };

  const deletePage = (id: TLPageId) => {
    // tldraw requires at least one page, so never delete the last remaining one.
    if (pages.length <= 1) return;
    // Deleting the current page is safe: tldraw switches to another page itself.
    editor.deletePage(id);
  };

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
          onClick={() => {
            onSelectApp('canvas');
            setView('canvases');
          }}
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
          canvas list or the selected canvas's pages. */}
      {activeApp === 'webpoc' ? null : view === 'canvases' ? (
        <div className="lp-body">
          <div className="left-panel-head">
            <span className="left-panel-title">Canvases</span>
          </div>
          <ul className="page-list">
            <li className="page-row active" onClick={() => setView('pages')}>
              <span className="page-name">{CANVAS_NAME}</span>
            </li>
          </ul>
        </div>
      ) : (
        <div className="lp-body">
          <div className="lp-breadcrumb">
            <button type="button" onClick={() => setView('canvases')} title="Canvases">
              Canvases
            </button>
            <span className="lp-crumb-sep" aria-hidden="true">
              ›
            </span>
            <span className="lp-crumb-cur">{CANVAS_NAME}</span>
          </div>
          <div className="left-panel-head">
            <span className="left-panel-title">Pages</span>
            <button type="button" className="left-panel-add" onClick={addPage} title="Create a new page">
              +
            </button>
          </div>
          <ul className="page-list">
            {pages.map((page) => {
              const active = page.id === currentPageId;
              return (
                <li
                  key={page.id}
                  className={`page-row${active ? ' active' : ''}`}
                  onClick={() => editor.setCurrentPage(page.id)}
                >
                  {editingId === page.id ? (
                    <input
                      className="page-rename"
                      value={draft}
                      autoFocus
                      // Stop the row's click-to-switch from firing while editing.
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="page-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(page.id, page.name);
                      }}
                    >
                      {page.name}
                    </span>
                  )}
                  {pages.length > 1 && (
                    <button
                      type="button"
                      className="page-del"
                      title="Delete page"
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePage(page.id);
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
