import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import { ChatView } from '../../shared/ChatView';
import { setCanvasOverride } from '../../shared/chat-store';
import { DOCK_CHAT, parseDockMessage } from '../../shared/dock-messages';
import { DOCK_MEMORY_KEY, DOCK_WIDTH_KEY, type DockMemory, type DockedChat, parseDockMemory, parseDockWidth, serializeDockMemory } from './canvas-dock';
import { clampWidth, MAX_PANE_WIDTH, MIN_PANE_WIDTH } from './inbox/inbox-panes';
import { canvasFromUrl, urlWithCanvas } from './canvas-url';
import { InboxStage } from './inbox/Inbox';
import { JobsStage } from './jobs/Jobs';
import { type Stage, stageFromUrl } from './stage';
import { createStageMemory } from './stage-memory';

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

// A play-in-a-square glyph for Jobs (trigger a background-agent run).
function IconJobs() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M10 8.5v7l5-3.5z" fill="currentColor" stroke="none" />
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
  // Per-tab memory of each stage's last URL (canvas's `?canvas=<id>`, inbox's filters — see
  // stage-memory.ts), so the rail restores them instead of always landing on the bare default.
  const stageMemory = useRef(createStageMemory()).current;

  // Stage selection is a URL, so a reload/bookmark/back-button lands on the same stage. Before
  // leaving, remember the outgoing stage's current search so returning to it restores it.
  const selectStage = (next: Stage) => {
    stageMemory.remember(stage, window.location.search);
    setStage(next);
    window.history.pushState(null, '', stageMemory.urlFor(next));
  };
  useEffect(() => {
    // Back/forward already re-derives the stage from its own history entry, which carries the
    // full state (each stage's replaceState calls keep it current). Just sync memory to match,
    // rather than having memory override what popstate restored.
    const onPop = () => {
      const next = stageFromUrl(window.location.search);
      stageMemory.remember(next, window.location.search);
      setStage(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stageMemory]);

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
      {stage === 'jobs' && <JobsStage />}
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
    // Only navigate away once the session cookie is actually cleared: a swallowed failure
    // here previously still redirected to `/`, where the gate still saw a valid session and
    // handed back the authenticated shell — indistinguishable from "sign out did nothing".
    const r = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not sign out — try again.');
      return;
    }
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
      {railBtn('inbox', 'Inbox', <IconInbox />)}
      {railBtn('canvas', 'Canvases', <IconCanvases />)}
      {railBtn('notebook', 'Notebook', <IconNotebook />)}
      {railBtn('jobs', 'Jobs', <IconJobs />)}
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

// The caller's workspaces — owned or member-of (#179) — from the edge registry
// (`GET /api/workspaces`; `default` leads when accessible). Opening one navigates to
// /w/:id — the Worker pins the cs_workspace cookie and bounces back to `/`. Fetched
// lazily: the closed rail costs nothing.
function WorkspacePopover({ activeWorkspace }: { activeWorkspace: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  // #179 owner-only invite. The server decides "owner": the pending-invitations GET is
  // 200 for the owner only (403 member / 404 stranger) — non-200 hides the affordance.
  const [canInvite, setCanInvite] = useState(false);
  const invitationsUrl = `/api/workspaces/${encodeURIComponent(activeWorkspace)}/invitations`;

  useEffect(() => {
    void (async () => {
      const r = await fetch('/api/workspaces', { credentials: 'same-origin' }).catch(() => null);
      if (!r?.ok) return;
      const d = (await r.json()) as { workspaces: WorkspaceEntry[] };
      setWorkspaces(d.workspaces);
    })();
  }, []);

  useEffect(() => {
    if (!activeWorkspace) return;
    void (async () => {
      const r = await fetch(invitationsUrl, { credentials: 'same-origin' }).catch(() => null);
      setCanInvite(r?.ok ?? false);
    })();
  }, [activeWorkspace, invitationsUrl]);

  const invite = async () => {
    const email = window.prompt('Invite to this workspace by email — the link works only for that address:');
    if (!email) return;
    const r = await fetch(invitationsUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not create the invitation.');
      return;
    }
    const d = (await r.json()) as { url: string };
    const link = `${window.location.origin}${d.url}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    window.prompt('Invite link (copied to clipboard) — send it over your own channel. Expires in 48h, single-use:', link);
  };

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
      {canInvite && (
        <div className="lp-ws-row lp-ws-invite" role="menuitem" onClick={() => void invite()}>
          <span className="lp-ws-glyph">+</span>
          <span className="lp-ws-name">Invite to workspace…</span>
        </div>
      )}
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
  loaded: boolean;
};

function useCanvasRegistry(): Registry {
  const [workspaceId, setWorkspaceId] = useState('');
  const [canvases, setCanvases] = useState<CanvasEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const r = await fetch('/api/canvases', { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) return; // edge offline — leave the list as-is
    const d = (await r.json()) as { workspaceId: string; canvases: CanvasEntry[] };
    setWorkspaceId(d.workspaceId);
    setCanvases(d.canvases);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return { workspaceId, canvases, setCanvases, reload, loaded };
}

/** Dock memory minus one canvas's slot (undock / the docked card was deleted). */
const withoutDock = (d: DockMemory, canvasId: string): DockMemory =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== canvasId));

function CanvasStage({ registry }: { registry: Registry }) {
  const { workspaceId: wsId, canvases, setCanvases, reload: load, loaded } = registry;
  // The selected canvas is a URL, so a reload/back-button lands back on the same open canvas.
  const [selected, setSelected] = useState<string | null>(() => canvasFromUrl(window.location.search));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // The docked chat, per canvas (CONTEXT.md "Docked chat") — per-device memory, restored
  // from localStorage on mount. The dock gesture is the ONE postMessage that crosses the
  // pad iframe's boundary — validated by origin AND shape.
  const [docks, setDocksState] = useState<DockMemory>(() => parseDockMemory(localStorage.getItem(DOCK_MEMORY_KEY)));
  const docked = selected ? (docks[selected] ?? null) : null;
  const setDocks = useCallback((mutate: (d: DockMemory) => DockMemory) => {
    setDocksState((d) => {
      const next = mutate(d);
      localStorage.setItem(DOCK_MEMORY_KEY, serializeDockMemory(next));
      return next;
    });
  }, []);
  // Drag-to-resize, same shape as the Inbox's pane divider; persists on release.
  const [dockWidth, setDockWidth] = useState(() => parseDockWidth(localStorage.getItem(DOCK_WIDTH_KEY)));
  const startDockResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = dockWidth;
    const onMove = (ev: PointerEvent) => {
      setDockWidth(clampWidth(startWidth + (ev.clientX - startX), MIN_PANE_WIDTH, MAX_PANE_WIDTH));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setDockWidth((w) => {
        localStorage.setItem(DOCK_WIDTH_KEY, String(w));
        return w;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || !selected) return;
      const msg = parseDockMessage(e.data);
      if (!msg) return;
      if (msg.type === DOCK_CHAT) {
        setDocks((d) => ({ ...d, [selected]: { chatId: msg.chatId, title: msg.title } }));
      } else {
        // The docked chat's card was deleted (its session closed with it) — the panel is a
        // projection of the card, so it undocks. Other cards' deletions are not ours.
        setDocks((d) => (d[selected]?.chatId === msg.chatId ? withoutDock(d, selected) : d));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [selected, setDocks]);

  useEffect(() => {
    const qs = urlWithCanvas(window.location.search, selected);
    window.history.replaceState(null, '', window.location.pathname + qs);
  }, [selected]);

  // The list always offers the legacy Default canvas (no registry row) so you can return to it.
  const canvasList: CanvasEntry[] = [{ id: DEFAULT_CANVAS_ID, name: 'Default' }, ...canvases];

  // A URL can name a canvas that no longer exists (deleted elsewhere, stale bookmark). Only
  // clear it once the registry has actually loaded — clearing before then would drop a valid
  // selection just because the async fetch hasn't landed yet.
  useEffect(() => {
    if (!loaded) return;
    if (selected && selected !== DEFAULT_CANVAS_ID && !canvases.some((c) => c.id === selected)) {
      setSelected(null);
    }
  }, [loaded, canvases, selected]);

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

      {/* The docked chat panel: the same shared <ChatView> the card renders, mounted at the
          Shell level beside the pad. A mirror — the card stays on the canvas; both are live
          views of one session, converging at the bridge. */}
      {selected && docked && (
        <div className="canvas-dock" style={{ width: dockWidth, flex: 'none' }}>
          <div className="canvas-dock-head">
            <b>{docked.title}</b>
            <button
              type="button"
              aria-label="Undock chat"
              title="Undock (the card stays on the canvas)"
              onClick={() => setDocks((d) => withoutDock(d, selected))}
            >
              ✕
            </button>
          </div>
          <DockedChatPane key={`${selected}:${docked.chatId}`} canvasId={selected} docked={docked} />
        </div>
      )}
      {selected && docked && <div className="canvas-dock-divider" onPointerDown={startDockResize} />}

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

// The docked chat body. The canvas override is stamped DURING render (ensureSession-style),
// before <ChatView>'s openStream effect fires — the Shell lives at `/`, so without it the
// chat's sends would route to the default store instead of the canvas the panel fronts.
function DockedChatPane({ canvasId, docked }: { canvasId: string; docked: DockedChat }) {
  setCanvasOverride(docked.chatId, canvasId);
  return (
    <div className="canvas-dock-body">
      <ChatView chatId={docked.chatId} title={docked.title} />
    </div>
  );
}
