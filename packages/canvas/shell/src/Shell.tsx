import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import { InboxStage } from './inbox/Inbox';
import { type Stage, stageFromUrl, urlForStage } from './stage';

// Notebook mounts lazily (PRD #103, slice #107) — the same lazy chunk the container app
// used to code-split (`src/App.tsx` pre-#106) — so opening the canvas or inbox stage never
// pulls in web-poc's Mantine/React-Query bundle.
const WebPocApp = lazy(() => import('../../web-poc/src/embed').then((m) => ({ default: m.WebPocApp })));

// The Shell: the ONE chrome (ADR-0007, PRD #103). A vite SPA served from the edge Worker's
// static-assets binding at `/`, so opening it never wakes (or bills) a container. The rail
// switches inline stages; picking a canvas mounts the Render Pad in a SAME-ORIGIN iframe at
// its own URL (`/w/:ws/canvas/:id/pad`) — the only thing here that reaches the container.
// Same-origin means the Better Auth cookie flows with no token handoff, and chat stays
// inside the pad: no `postMessage` protocol.
//
// The rail + canvas selector are ported from the container app's old left-panel component
// (deleted in this slice). They were already editor-free and already talked only to edge
// APIs, so this is a move, not a rewrite. The one behavioural change: the workspace popover
// lists the owner's real workspaces from `GET /api/workspaces` instead of a hardcoded name.

/** The legacy prod canvas — no registry row, but always openable. Mirrors worker DEFAULT_CANVAS_ID. */
const DEFAULT_CANVAS_ID = 'default';

type CanvasEntry = { id: string; name: string };
type WorkspaceEntry = { id: string; name: string };

function IconCanvases() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}

// A small node-graph glyph for the Notebook (the Problem/Solution knowledge graph).
function IconNotebook() {
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

function IconInbox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13h4l2 3h6l2-3h4" />
      <path d="M5 5h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z" />
    </svg>
  );
}

/** Close `onClose` on outside-click or Escape, for the rail's two popovers. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onClose]);
}

export function Shell() {
  const [stage, setStage] = useState<Stage>(() => stageFromUrl(window.location.search));

  // Stage selection is a URL, so a reload/bookmark/back-button lands on the same stage.
  const selectStage = (next: Stage) => {
    setStage(next);
    window.history.pushState(null, '', urlForStage(next));
  };
  useEffect(() => {
    const onPop = () => setStage(stageFromUrl(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The canvas registry, loaded once here rather than per-stage: it names the active
  // workspace (the cs_workspace cookie is HttpOnly, so the client can't read it), which the
  // rail's workspace popover needs to mark the current row.
  const registry = useCanvasRegistry();

  return (
    <div className="shell">
      <Rail stage={stage} onSelectStage={selectStage} activeWorkspace={registry.workspaceId} />
      {stage === 'canvas' && <CanvasStage registry={registry} />}
      {stage === 'notebook' && (
        <div className="shell-stage stage-notebook">
          {/* Notebook scopes to the rail's active workspace rather than choosing its own
              (PRD #103, slice #107) — the rail is the one place a workspace is picked. */}
          <Suspense fallback={null}>
            <WebPocApp workspaceId={registry.workspaceId || undefined} />
          </Suspense>
        </div>
      )}
      {stage === 'inbox' && <InboxStage />}
    </div>
  );
}

// ---- Rail -----------------------------------------------------------------
// Icon rail: workspace mark, the three stages, operator avatar pinned bottom.

function Rail({
  stage,
  onSelectStage,
  activeWorkspace,
}: {
  stage: Stage;
  onSelectStage: (s: Stage) => void;
  activeWorkspace: string;
}) {
  const [wsOpen, setWsOpen] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useDismiss(wsOpen || meOpen, ref, () => {
    setWsOpen(false);
    setMeOpen(false);
  });

  const signOut = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    window.location.href = '/';
  };

  const railBtn = (s: Stage, title: string, icon: React.ReactNode) => (
    <button
      type="button"
      className={`lp-rail-btn${stage === s ? ' active' : ''}`}
      title={title}
      aria-current={stage === s ? 'page' : undefined}
      onClick={() => onSelectStage(s)}
    >
      {icon}
    </button>
  );

  return (
    <nav className="lp-rail" aria-label="Workspace" ref={ref}>
      <button
        type="button"
        className={`lp-rail-btn lp-z${wsOpen ? ' active' : ''}`}
        title="Workspaces"
        aria-haspopup="menu"
        aria-expanded={wsOpen}
        onClick={() => {
          setMeOpen(false);
          setWsOpen((v) => !v);
        }}
      >
        Z
      </button>
      {railBtn('canvas', 'Canvases', <IconCanvases />)}
      {railBtn('notebook', 'Notebook', <IconNotebook />)}
      {railBtn('inbox', 'Inbox', <IconInbox />)}
      <div className="lp-rail-bottom">
        <button
          type="button"
          className="lp-avatar"
          title="Account"
          aria-haspopup="menu"
          aria-expanded={meOpen}
          onClick={() => {
            setWsOpen(false);
            setMeOpen((v) => !v);
          }}
        >
          J
        </button>
      </div>

      {wsOpen && <WorkspacePopover activeWorkspace={activeWorkspace} />}
      {meOpen && (
        <div className="lp-me-popover" role="menu">
          <button type="button" className="lp-signout" role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}

// The owner's workspaces, from the edge registry (`GET /api/workspaces`, which always leads
// with the legacy `default`). Opening one navigates to /w/:id — the Worker pins the
// cs_workspace cookie and bounces back to `/`. Fetched lazily: the closed rail costs nothing.
function WorkspacePopover({ activeWorkspace }: { activeWorkspace: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);

  useEffect(() => {
    void (async () => {
      const r = await fetch('/api/workspaces', { credentials: 'same-origin' }).catch(() => null);
      if (!r?.ok) return;
      const d = (await r.json()) as { workspaces: WorkspaceEntry[] };
      setWorkspaces(d.workspaces);
    })();
  }, []);

  return (
    <div className="lp-ws-popover" role="menu">
      <div className="lp-ws-label">Workspaces</div>
      {workspaces.map((w) => {
        const active = w.id === activeWorkspace;
        return (
          <div
            key={w.id}
            className={`lp-ws-row${active ? ' active' : ''}`}
            role="menuitemradio"
            aria-checked={active}
            onClick={() => {
              window.location.href = `/w/${encodeURIComponent(w.id)}`;
            }}
          >
            <span className="lp-ws-glyph">{w.name.slice(0, 1).toUpperCase()}</span>
            <span className="lp-ws-name">{w.name}</span>
            {active && (
              <span className="lp-ws-check" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7" />
                </svg>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Canvas stage ---------------------------------------------------------
// The canvases of the active workspace (`GET /api/canvases`, scoped by the HttpOnly
// cs_workspace cookie), plus the Render Pad of whichever one is picked.

type Registry = {
  workspaceId: string;
  canvases: CanvasEntry[];
  setCanvases: React.Dispatch<React.SetStateAction<CanvasEntry[]>>;
  reload: () => Promise<void>;
};

function useCanvasRegistry(): Registry {
  const [workspaceId, setWorkspaceId] = useState('');
  const [canvases, setCanvases] = useState<CanvasEntry[]>([]);

  const reload = useCallback(async () => {
    const r = await fetch('/api/canvases', { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) return; // edge offline — leave the list as-is
    const d = (await r.json()) as { workspaceId: string; canvases: CanvasEntry[] };
    setWorkspaceId(d.workspaceId);
    setCanvases(d.canvases);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return { workspaceId, canvases, setCanvases, reload };
}

function CanvasStage({ registry }: { registry: Registry }) {
  const { workspaceId: wsId, canvases, setCanvases, reload: load } = registry;
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // The list always offers the legacy Default canvas (no registry row) so you can return to it.
  const canvasList: CanvasEntry[] = [{ id: DEFAULT_CANVAS_ID, name: 'Default' }, ...canvases];

  const createCanvas = async () => {
    const r = await fetch('/api/canvases', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Canvas ${canvases.length + 1}` }),
    });
    if (!r.ok) return;
    const c = (await r.json()) as CanvasEntry;
    setCanvases((cs) => [...cs, c]);
    setSelected(c.id);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const name = draft.trim();
    const id = editingId;
    setEditingId(null);
    if (!name) return;
    await fetch(`/api/canvases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    void load();
  };

  const deleteCanvas = async (id: string) => {
    await fetch(`/api/canvases/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    if (selected === id) setSelected(null);
    void load();
  };

  return (
    <div className="shell-stage stage-canvas">
      <aside className="canvas-picker">
        <div className="left-panel-head">
          <span className="left-panel-title">Canvases</span>
          <button type="button" className="left-panel-add" onClick={() => void createCanvas()} title="Create a new canvas">
            +
          </button>
        </div>
        <ul className="page-list">
          {canvasList.map((c) => (
            <li
              key={c.id}
              className={`page-row${c.id === selected ? ' active' : ''}`}
              onClick={() => setSelected(c.id)}
            >
              {editingId === c.id ? (
                <input
                  className="page-rename"
                  value={draft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename();
                    else if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <span
                  className="page-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    // The legacy Default canvas has no registry row, so it can't be renamed.
                    if (c.id === DEFAULT_CANVAS_ID) return;
                    setEditingId(c.id);
                    setDraft(c.name);
                  }}
                >
                  {c.name}
                </span>
              )}
              {c.id !== DEFAULT_CANVAS_ID && c.id !== selected && (
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
          ))}
        </ul>
      </aside>

      {/* Mounting this iframe is the ONLY thing that wakes the container. Same-origin, so the
          session cookie rides along and the pad's chat/SSE work exactly as they do standalone. */}
      {selected && wsId ? (
        <iframe
          className="pad-frame"
          title="Render Pad"
          src={`/w/${encodeURIComponent(wsId)}/canvas/${encodeURIComponent(selected)}/pad`}
        />
      ) : (
        <div className="pad-empty">Pick a canvas to open it.</div>
      )}
    </div>
  );
}
