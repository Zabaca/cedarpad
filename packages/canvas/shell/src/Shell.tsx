import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatView } from '../../shared/ChatView';
import { setCanvasOverride } from '../../shared/chat-store';
import { DOCK_CHAT, parseDockMessage } from '../../shared/dock-messages';
import {
  DOCK_MEMORY_KEY,
  DOCK_WIDTH_KEY,
  type DockMemory,
  type DockedChat,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  clampWidth,
  parseDockMemory,
  parseDockWidth,
  serializeDockMemory,
} from './canvas-dock';
import { canvasFromUrl, urlWithCanvas } from './canvas-url';
import { SettingsStage } from './settings/Settings';
import { ComponentsStage } from './components/Components';
import { applyCanvasOrder, moved } from './canvas-order';
import { type Stage, stageFromUrl } from './stage';
import { createStageMemory } from './stage-memory';

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

/** The legacy prod canvas — no registry row, openable only in the `default` workspace it
 *  belongs to. Mirrors worker DEFAULT_CANVAS_ID / DEFAULT_WORKSPACE_ID. */
const DEFAULT_CANVAS_ID = 'default';
const DEFAULT_WORKSPACE_ID = 'default';

// Sticky collapse state for the two stage nav panels (full-width content on demand).
const PICKER_COLLAPSED_KEY = 'shell:canvasPickerCollapsed';

// ADR-0016: `visibility`+`mine` ride every registry row; `locked` rows (someone else's
// private canvas) reach only the workspace owner and are for Settings' manage list —
// the picker must never offer them.
type CanvasEntry = {
  id: string;
  name: string;
  visibility?: 'workspace' | 'private';
  mine?: boolean;
  locked?: boolean;
  createdBy?: string | null;
};
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

// A gear glyph for workspace Settings (#192).
function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconComponents() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
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

// #220 slice 5: what the edge answers on GET /api/guest-session — null for members,
// the link's scope for a cs_guest session (worker/guest-session.ts is the contract's owner).
interface GuestScope {
  canvasId: string;
  workspaceId: string;
  guestChat: boolean;
}

export function Shell() {
  // Guest probe BEFORE any workspace chrome mounts: a guest session must render only the
  // locked pad and never call the registries (the gate would deny them anyway — don't ask).
  const [guest, setGuest] = useState<GuestScope | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch('/api/guest-session')
      .then((r) => (r.ok ? (r.json() as Promise<GuestScope | null>) : null))
      .then((g) => alive && setGuest(g))
      .catch(() => alive && setGuest(null));
    return () => {
      alive = false;
    };
  }, []);
  if (guest === undefined) return null;
  if (guest) return <GuestShell guest={guest} />;
  return <MemberShell />;
}

// Guest mode: the same bundle, none of the chrome — a fullscreen pad hard-locked to the
// link's canvas. The pad app inside the iframe falls back to the per-browser guest
// identity (#211) for attribution, so no session plumbing is needed here.
function GuestShell({ guest }: { guest: GuestScope }) {
  return (
    <div className="shell shell-guest">
      <div className="shell-stage stage-canvas">
        <iframe
          className="pad-frame"
          title="Render Pad"
          src={`/w/${encodeURIComponent(guest.workspaceId)}/canvas/${encodeURIComponent(guest.canvasId)}/pad`}
        />
      </div>
    </div>
  );
}

function MemberShell() {
  const [stage, setStage] = useState<Stage>(() => stageFromUrl(window.location.search));
  // Per-tab memory of each stage's last URL (canvas's `?canvas=<id>` — see
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
      {stage === 'components' && <ComponentsStage workspaceId={registry.workspaceId} />}
      {stage === 'settings' && <SettingsStage workspaceId={registry.workspaceId} />}
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
    // Better Auth requires a JSON POST — a body-less send with no content-type is rejected
    // 415 Unsupported Media Type in production (observed live), which is what "sign out
    // does nothing" actually was.
    const r = await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => null);
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
      {railBtn('canvas', 'Canvases', <IconCanvases />)}
      {railBtn('components', 'Components', <IconComponents />)}
      <div className="lp-rail-bottom">
        {railBtn('settings', 'Settings', <IconSettings />)}
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

      {wsOpen && (
        <WorkspacePopover
          activeWorkspace={activeWorkspace}
          onOpenSettings={() => {
            setWsOpen(false);
            onSelectStage('settings');
          }}
        />
      )}
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
function WorkspacePopover({ activeWorkspace, onOpenSettings }: { activeWorkspace: string; onOpenSettings: () => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  // Workspace creation is admin-only; the server answers `canCreate` alongside the list.
  const [canCreate, setCanCreate] = useState(false);
  // #179 owner-only invite. The server decides "owner": the pending-invitations GET is
  // 200 for the owner only (403 member / 404 stranger) — non-200 hides the affordance.
  const [canInvite, setCanInvite] = useState(false);
  const invitationsUrl = `/api/workspaces/${encodeURIComponent(activeWorkspace)}/invitations`;

  useEffect(() => {
    void (async () => {
      const r = await fetch('/api/workspaces', { credentials: 'same-origin' }).catch(() => null);
      if (!r?.ok) return;
      const d = (await r.json()) as { workspaces: WorkspaceEntry[]; canCreate?: boolean };
      setWorkspaces(d.workspaces);
      setCanCreate(d.canCreate === true);
    })();
  }, []);

  useEffect(() => {
    if (!activeWorkspace) return;
    void (async () => {
      const r = await fetch(invitationsUrl, { credentials: 'same-origin' }).catch(() => null);
      setCanInvite(r?.ok ?? false);
    })();
  }, [activeWorkspace, invitationsUrl]);

  const createWorkspace = async () => {
    const name = window.prompt('Name the new workspace:');
    if (!name?.trim()) return;
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not create the workspace.');
      return;
    }
    const d = (await r.json()) as { id: string };
    window.location.href = `/w/${encodeURIComponent(d.id)}`;
  };

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
      {canCreate && (
        <div className="lp-ws-row lp-ws-create" role="menuitem" onClick={() => void createWorkspace()}>
          <span className="lp-ws-glyph">+</span>
          <span className="lp-ws-name">New workspace…</span>
        </div>
      )}
      {canInvite && (
        <div className="lp-ws-row lp-ws-invite" role="menuitem" onClick={() => void invite()}>
          <span className="lp-ws-glyph">+</span>
          <span className="lp-ws-name">Invite to workspace…</span>
        </div>
      )}
      <div className="lp-ws-row lp-ws-settings" role="menuitem" onClick={onOpenSettings}>
        <span className="lp-ws-glyph">⚙</span>
        <span className="lp-ws-name">Workspace settings…</span>
      </div>
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
  /** The hand-arranged picker order (shell/src/canvas-order.ts). A HINT: it can name
   *  deleted canvases and will not know about ones created since it was written. */
  canvasOrder: string[];
  setCanvasOrder: React.Dispatch<React.SetStateAction<string[]>>;
  reload: () => Promise<void>;
  loaded: boolean;
};

function useCanvasRegistry(): Registry {
  const [workspaceId, setWorkspaceId] = useState('');
  const [canvases, setCanvases] = useState<CanvasEntry[]>([]);
  const [canvasOrder, setCanvasOrder] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const r = await fetch('/api/canvases', { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) return; // edge offline — leave the list as-is
    const d = (await r.json()) as { workspaceId: string; canvases: CanvasEntry[]; canvasOrder?: string[] };
    setWorkspaceId(d.workspaceId);
    setCanvases(d.canvases);
    setCanvasOrder(d.canvasOrder ?? []);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return { workspaceId, canvases, setCanvases, canvasOrder, setCanvasOrder, reload, loaded };
}

/** Dock memory minus one canvas's slot (undock / the docked card was deleted). */
const withoutDock = (d: DockMemory, canvasId: string): DockMemory =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== canvasId));

function CanvasStage({ registry }: { registry: Registry }) {
  const { workspaceId: wsId, canvases, setCanvases, canvasOrder, setCanvasOrder, reload: load, loaded } = registry;
  // Which row is being dragged, and which it is currently over — the only state a native
  // HTML5 drag needs beyond the list itself.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
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
  // Drag-to-resize; persists on release.
  const [dockWidth, setDockWidth] = useState(() => parseDockWidth(localStorage.getItem(DOCK_WIDTH_KEY)));
  const startDockResize = (e: React.PointerEvent) => {
    e.preventDefault();
    // The pad iframe next door swallows pointer events the moment the cursor
    // crosses into it: the drag freezes unless moved slowly, and a release over
    // the iframe never reaches this document (the divider "sticks" to the
    // cursor). Pointer capture pins the whole stream to the divider element —
    // captured events retarget there and bubble to these document listeners —
    // so what's under the cursor stops mattering.
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = dockWidth;
    const onMove = (ev: PointerEvent) => {
      setDockWidth(clampWidth(startWidth + (ev.clientX - startX), MIN_PANE_WIDTH, MAX_PANE_WIDTH));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      setDockWidth((w) => {
        localStorage.setItem(DOCK_WIDTH_KEY, String(w));
        return w;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
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

  // The `default` workspace's list offers its legacy Default canvas (no registry row) so you
  // can return to it. Canvas ids are global, so offering it anywhere else would open the
  // `default` workspace's canvas from inside another workspace.
  // Locked rows (ADR-0016 — someone else's private canvas, owner-only metadata) are never
  // pickable; they surface in Settings' manage list instead.
  // The order is applied HERE, after Default is synthesized in — that is the whole reason
  // it is an id array rather than a sort column: `default` has no registry row, so the
  // server could not place it, but the client can because by this point it is just an id.
  const canvasList: CanvasEntry[] = applyCanvasOrder(canvasOrder, [
    ...(wsId === DEFAULT_WORKSPACE_ID ? [{ id: DEFAULT_CANVAS_ID, name: 'Default' }] : []),
    ...canvases.filter((c) => !c.locked),
  ]);

  // Reorder by drag. The new arrangement is applied LOCALLY FIRST and then persisted: a
  // dropped row that snaps back while a fetch is in flight reads as a failed drag, and the
  // list is small enough that re-fetching to confirm would be the slower, worse answer.
  // A failed write reloads, which restores the server's order rather than leaving the
  // screen disagreeing with the database.
  const reorder = (fromId: string, toId: string) => {
    const ids = canvasList.map((c) => c.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = moved(ids, from, to);
    setCanvasOrder(next);
    void fetch('/api/canvases', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: next }),
    })
      .then((r) => {
        if (!r.ok) void load();
      })
      .catch(() => void load());
  };

  // A URL can name a canvas that no longer exists (deleted elsewhere, stale bookmark). Only
  // clear it once the registry has actually loaded — clearing before then would drop a valid
  // selection just because the async fetch hasn't landed yet.
  useEffect(() => {
    if (!loaded) return;
    const exists = selected === DEFAULT_CANVAS_ID ? wsId === DEFAULT_WORKSPACE_ID : canvases.some((c) => c.id === selected);
    if (selected && !exists) {
      setSelected(null);
    }
  }, [loaded, canvases, selected, wsId]);

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
    if (shareCanvasId === id) setShareCanvasId(null);
    void load();
  };

  // #220: which canvas's Share panel is open (per-row share button; toggles closed on a
  // second click). Guest links are canvas ADR-0015 capability rows; this is just their
  // member-facing mint/copy/revoke surface.
  const [shareCanvasId, setShareCanvasId] = useState<string | null>(null);

  // Collapse the canvas picker to a slim strip (full-width canvas). Sticky per browser.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(PICKER_COLLAPSED_KEY) === '1');
  useEffect(() => {
    try {
      localStorage.setItem(PICKER_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable: skip */
    }
  }, [collapsed]);

  return (
    <div className="shell-stage stage-canvas">
      {collapsed ? (
        <aside className="canvas-picker collapsed">
          <button type="button" className="panel-collapse" title="Show canvases" onClick={() => setCollapsed(false)}>
            »
          </button>
        </aside>
      ) : (
      <aside className="canvas-picker">
        <div className="left-panel-head">
          <span className="left-panel-title">Canvases</span>
          <button type="button" className="left-panel-add" onClick={() => void createCanvas()} title="Create a new canvas">
            +
          </button>
          <button type="button" className="panel-collapse" title="Hide canvases (full canvas)" onClick={() => setCollapsed(true)}>
            «
          </button>
        </div>
        {shareCanvasId && <SharePanel canvasId={shareCanvasId} />}
        <ul className="page-list">
          {canvasList.map((c) => (
            <li
              key={c.id}
              className={`page-row${c.id === selected ? ' active' : ''}${dragId === c.id ? ' dragging' : ''}${overId === c.id && dragId !== c.id ? ' drop-target' : ''}`}
              onClick={() => setSelected(c.id)}
              // Native HTML5 drag — the list is a dozen rows, so a drag library would be
              // more code and more behaviour than the feature is.
              draggable={editingId !== c.id}
              onDragStart={(e) => {
                setDragId(c.id);
                e.dataTransfer.effectAllowed = 'move';
                // Firefox starts no drag at all without data set on the transfer.
                e.dataTransfer.setData('text/plain', c.id);
              }}
              onDragOver={(e) => {
                e.preventDefault(); // the default is "reject the drop"
                e.dataTransfer.dropEffect = 'move';
                setOverId(c.id);
              }}
              onDragLeave={() => setOverId((id) => (id === c.id ? null : id))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) reorder(dragId, c.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
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
              {c.mine && c.id !== DEFAULT_CANVAS_ID && (
                <button
                  type="button"
                  className={`page-visibility${c.visibility === 'private' ? ' locked' : ''}`}
                  title={c.visibility === 'private' ? 'Private — only you can see this. Click to make workspace-visible.' : 'Workspace-visible. Click to make private.'}
                  onClick={(e) => {
                    e.stopPropagation();
                    void (async () => {
                      await fetch(`/api/canvases/${encodeURIComponent(c.id)}`, {
                        method: 'PATCH',
                        credentials: 'same-origin',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ visibility: c.visibility === 'private' ? 'workspace' : 'private' }),
                      }).catch(() => {});
                      void load();
                    })();
                  }}
                >
                  {c.visibility === 'private' ? '🔒' : '🔓'}
                </button>
              )}
              <button
                type="button"
                className="page-share"
                title="Share this canvas"
                onClick={(e) => {
                  e.stopPropagation();
                  setShareCanvasId((open) => (open === c.id ? null : c.id));
                }}
              >
                <ShareIcon />
              </button>
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
      )}

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

// #220: the conventional "share nodes" glyph (three connected dots), inline so it themes
// with the row via currentColor — no icon library.
function ShareIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.7" y1="10.6" x2="15.3" y2="6.4" />
      <line x1="8.7" y1="13.4" x2="15.3" y2="17.6" />
    </svg>
  );
}

// #220: mint/copy/revoke guest share links for one canvas. Revoked links vanish from the
// panel (the edge keeps them tombstoned); the URL is the /share/<id> door.
function SharePanel({ canvasId }: { canvasId: string }) {
  type ShareLink = { id: string; guestChat: boolean; revokedAt: string | number | null };
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [guestChat, setGuestChat] = useState(false);
  // #320: what this link will let a guest DO, decided here at mint time. Using a component
  // is on by default (a link exists to show someone something); the two editing grants are
  // deliberate opt-ins, because a link already handed out must never gain them later.
  const [caps, setCaps] = useState({ guestInteract: true, guestEdit: false, guestEditSource: false });
  const base = `/api/canvases/${encodeURIComponent(canvasId)}/share-links`;

  const load = useCallback(async () => {
    const r = await fetch(base, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) return;
    const { links: all } = (await r.json()) as { links: ShareLink[] };
    setLinks(all.filter((l) => !l.revokedAt));
  }, [base]);
  useEffect(() => void load(), [load]);

  const mint = async () => {
    await fetch(base, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guestChat, ...caps }),
    }).catch(() => {});
    void load();
  };
  const revoke = async (id: string) => {
    await fetch(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    void load();
  };
  const urlFor = (id: string) => `${window.location.origin}/share/${id}`;

  return (
    <div className="share-panel">
      {links.map((l) => (
        <div key={l.id} className="share-row">
          <span className="share-url" title={urlFor(l.id)}>
            {urlFor(l.id)}
          </span>
          {/* Outside .share-url: the URL span truncates with ellipsis, which made the
              old inline " · chat" suffix invisible — links looked identical. */}
          {l.guestChat && <span className="share-chat-badge">chat</span>}
          <button
            type="button"
            className="share-copy"
            title="Copy link"
            onClick={() => void navigator.clipboard?.writeText(urlFor(l.id)).catch(() => {})}
          >
            ⧉
          </button>
          <button type="button" className="share-revoke" title="Revoke link" onClick={() => void revoke(l.id)}>
            ✕
          </button>
        </div>
      ))}
      <label className="share-chat-toggle">
        <input type="checkbox" checked={guestChat} onChange={(e) => setGuestChat(e.target.checked)} />
        guests can start a chat
      </label>
      {/* Phrased as what a guest can DO — a member minting a link is deciding about
          people, not about columns. */}
      {(
        [
          ['guestInteract', 'guests can use components (click buttons, submit forms)'],
          ['guestEdit', 'guests can edit the canvas (add, move, delete cards)'],
          ['guestEditSource', 'guests can edit component code on this canvas'],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="share-chat-toggle">
          <input
            type="checkbox"
            name={key}
            checked={caps[key]}
            onChange={(e) => setCaps((prev) => ({ ...prev, [key]: e.target.checked }))}
          />
          {label}
        </label>
      ))}
      <button type="button" className="share-new" onClick={() => void mint()}>
        New share link
      </button>
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
