import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';

import { ChatView } from '../../../shared/ChatView';
import { onChatFrame, openFrameSignal, setConnectionTarget } from '../../../shared/chat-store';
import type { InboxChatResponse, InboxItem, InboxListResponse, InboxView } from './contract';
import { padUrlFor } from './inbox-pad-url';
import {
  CANVAS_HIDDEN_KEY,
  clampWidth,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  PANE_WIDTHS_KEY,
  type PaneWidths,
  parseCanvasHidden,
  parsePaneWidths,
  serializePaneWidths,
} from './inbox-panes';
import { inboxStateFromUrl, urlWithInboxState } from './inbox-url';

// The Inbox stage (ADR-0009 / #124): the `stage === 'inbox'` case of the Shell, under the ONE
// chrome (the rail). Panes over the edge API: a left LIST of the user's Conversations
// (Turso only, SCOPED SERVER-SIDE to the active workspace — waiting_on:human badged, unread dot,
// status filter, never wakes a runner), a THREAD that is a LIVE <ChatView> over the
// Conversation's OWNING bridge (through the /inbox/:id/bridge proxy) — streaming transcript +
// reply + image paste, the SAME component the canvas renders — and, once a conversation is open,
// a third CANVAS pane: the chat→canvas edge (`InboxItem.canvasId`, worker/inbox-view.ts) rendered
// as the same live same-origin Render Pad iframe `CanvasStage` mounts, or a placeholder when
// nothing's linked yet. Only OPENING a conversation wakes its runner; browsing does not.
// The pane widths + the canvas-pane visibility are per-device UI prefs, persisted to
// localStorage (`inbox-panes.ts` owns the pure clamp/serialize logic).

/** The edge chat proxy prefix a Conversation's <ChatView> addresses its owning bridge through. */
const bridgePrefix = (convId: string): string => `/inbox/${encodeURIComponent(convId)}/bridge`;

/** The list preview mirrors the old page: last message, else the summary. */
const preview = (it: InboxItem): string => it.lastMessagePreview ?? it.summary ?? '';

export function InboxStage() {
  // Filters + selection are URL-persisted: a reload lands back on the same view/selected
  // conversation, the same spirit as stage.ts. Parsed once, lazily, on mount.
  const [initialUrlState] = useState(() => inboxStateFromUrl(window.location.search));
  // The unified session index, scoped server-side to the active workspace: "Open" (default) =
  // every open session; "All" = every session (canvas chats, dev-agent runs, open and closed);
  // "Closed" = the archive. The waiting_on:human pinning (worker/inbox-view.ts `orderInbox`)
  // still surfaces attention at the top of Open.
  const [view, setView] = useState<InboxView>(initialUrlState.view);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  // The opened Conversation (the whole item, so the thread keeps its summary/status even after a
  // close drops it from the filtered list). null = nothing open.
  const [current, setCurrent] = useState<InboxItem | null>(null);
  // A `conv` named in the URL on mount is selected once the (async) list loads and contains it —
  // it may live in a different view than the one showing; cleared after the first load attempt
  // whether or not it matched, since after that the selection is user-driven.
  const pendingConvId = useRef(initialUrlState.conv);

  // Column management (drag-to-resize + canvas-pane toggle): per-device UI prefs, restored from
  // localStorage on mount.
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => parsePaneWidths(localStorage.getItem(PANE_WIDTHS_KEY)));
  const [canvasHidden, setCanvasHidden] = useState(() => parseCanvasHidden(localStorage.getItem(CANVAS_HIDDEN_KEY)));

  // The list is a pure function of the view filter, so re-query whenever it changes — this is
  // what makes a view change re-fetch `/api/inbox?view=…`. No `workspace` param: the list is
  // scoped server-side to the active workspace (the `cs_workspace` cookie, worker/inbox.ts).
  const loadList = useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set('view', view);
    const r = await fetch(`/api/inbox?${qs.toString()}`, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      setItems([]);
      setState('error');
      return;
    }
    const d = (await r.json()) as InboxListResponse;
    setItems(d.items);
    setState('ready');
    // Refresh the opened item from the authoritative list (it's a snapshot): an attach
    // (canvasId), a rename, or a triage flip should reach the thread + canvas pane without
    // reselecting. Keep the snapshot when the row left the filtered list (e.g. just closed).
    setCurrent((cur) => (cur ? (d.items.find((it) => it.id === cur.id) ?? cur) : cur));
    if (pendingConvId.current) {
      const match = d.items.find((it) => it.id === pendingConvId.current);
      if (match) setCurrent(match);
      pendingConvId.current = null;
    }
    // Open the doorbell stream through any conversation's bridge proxy (they all resolve to
    // the warm default container, whose chat stream broadcasts every chat's frames).
    // Idempotent: the shared stream is a singleton.
    if (d.items[0]) openFrameSignal(bridgePrefix(d.items[0].id));
  }, [view]);

  // Keep the URL in sync with the filter + selection — replace, not push, so twiddling filters
  // never bloats back-button history (Shell.tsx already owns pushState for the stage itself).
  useEffect(() => {
    const qs = urlWithInboxState(window.location.search, { view, conv: current?.id ?? null });
    window.history.replaceState(null, '', window.location.pathname + qs);
  }, [view, current?.id]);

  useEffect(() => {
    void loadList();
    // Push-driven list: the container's chat stream is the doorbell — frames that imply a
    // row changed (turn start, turn settle, an end_turn declaration) trigger a debounced
    // refetch of the authoritative Turso list. A slow poll + tab-return refetch stay as the
    // safety net (the stream can be closed by the idle gate or drop mid-deploy). The stream
    // itself is opened by loadList once it knows a conversation to route through.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const ring = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void loadList(), 800);
    };
    const offFrames = onChatFrame((_chatId, ev) => {
      if (ev.kind === 'init' || ev.kind === 'done' || (ev.kind === 'tool' && ev.name === 'end_turn')) ring();
    });
    const tick = () => {
      if (!document.hidden) void loadList();
    };
    const t = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      offFrames();
      clearTimeout(debounce);
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadList]);

  // Drag-to-resize: a plain pointer-event drag on a thin divider. `pane` names the LEFT
  // neighbor whose width is set explicitly; the divider between thread|canvas drags `thread`,
  // the one between list|thread drags `list`. Persists to localStorage on release.
  const startResize = (pane: keyof PaneWidths) => (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = paneWidths[pane];
    const onMove = (ev: PointerEvent) => {
      const next = clampWidth(startWidth + (ev.clientX - startX), MIN_PANE_WIDTH, MAX_PANE_WIDTH);
      setPaneWidths((w) => ({ ...w, [pane]: next }));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setPaneWidths((w) => {
        localStorage.setItem(PANE_WIDTHS_KEY, serializePaneWidths(w));
        return w;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const toggleCanvas = () => {
    setCanvasHidden((hidden) => {
      const next = !hidden;
      localStorage.setItem(CANVAS_HIDDEN_KEY, String(next));
      return next;
    });
  };

  // The canvas pane (the attach panel counts as it) only exists once a conversation is open —
  // the thread takes its space, fixed-width, only when the canvas pane is actually showing.
  const showCanvas = !!current && !canvasHidden;

  return (
    <div className="shell-stage stage-inbox">
      <div className="inbox-list" style={{ width: paneWidths.list, flex: 'none' }}>
        <div className="inbox-filters">
          <select aria-label="View filter" value={view} onChange={(e) => setView(e.target.value as InboxView)}>
            <option value="open">Open</option>
            <option value="all">All sessions</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div className="inbox-items">
          {state === 'error' ? (
            <div className="inbox-empty">Failed to load.</div>
          ) : state === 'loading' ? (
            <div className="inbox-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="inbox-empty">No conversations.</div>
          ) : (
            items.map((it) => (
              <ItemRow key={it.id} item={it} selected={current?.id === it.id} onOpen={() => setCurrent(it)} />
            ))
          )}
        </div>
      </div>
      <div className="inbox-divider" onPointerDown={startResize('list')} />
      <div className="inbox-thread" style={showCanvas ? { flex: `0 0 ${paneWidths.thread}px` } : undefined}>
        {current ? (
          <Thread
            key={current.id}
            item={current}
            onListReload={loadList}
            canvasHidden={canvasHidden}
            onToggleCanvas={toggleCanvas}
          />
        ) : (
          <div className="inbox-empty">Select a conversation.</div>
        )}
      </div>
      {showCanvas && current && (
        <>
          <div className="inbox-divider" onPointerDown={startResize('thread')} />
          <CanvasPane item={current} onAttached={loadList} />
        </>
      )}
    </div>
  );
}

// The linked canvas, third pane: a live Render Pad iframe when the conversation has a
// `canvasId`, else the attach panel (link an existing same-workspace canvas, or create one
// named from the chat summary). Keyed by conversation + canvasId so switching conversations
// remounts the iframe cleanly rather than reusing a stale one.
function CanvasPane({ item, onAttached }: { item: InboxItem; onAttached: () => void }) {
  const padUrl = padUrlFor(item);
  return (
    <div className="inbox-canvas">
      {padUrl ? (
        <iframe key={`${item.id}:${item.canvasId}`} className="inbox-canvas-frame" title="canvas" src={padUrl} />
      ) : (
        <AttachPanel key={item.id} item={item} onAttached={onAttached} />
      )}
    </div>
  );
}

// The attach panel (canvas pairing): the empty state of the third pane. Both actions call
// the bridge's attach endpoint through the edge chat proxy; on success the list refetch
// brings back the item with its canvasId set, which swaps this panel for the live pad.
function AttachPanel({ item, onAttached }: { item: InboxItem; onAttached: () => void }) {
  const [canvases, setCanvases] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The workspace's canvases, from the edge registry (scoped by ?workspace — the
  // conversation's workspace, not the rail's cs_workspace cookie). 'default' is the
  // registry-less legacy canvas every workspace offers (mirrors Shell.tsx).
  useEffect(() => {
    let alive = true;
    void fetch(`/api/canvases?workspace=${encodeURIComponent(item.workspaceId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ canvases: Array<{ id: string; name: string }> }>) : null))
      .then((d) => {
        if (alive && d) setCanvases([{ id: 'default', name: 'Default' }, ...d.canvases]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [item.workspaceId]);

  const attach = async (body: { canvasId?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${bridgePrefix(item.id)}/api/inbox/${encodeURIComponent(item.id)}/attach-canvas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `attach failed (${res.status})`);
      }
      onAttached();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="inbox-canvas-empty">
      <b>No canvas linked</b>
      <div className="inbox-attach-row">
        <select value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Pick a canvas…</option>
          {canvases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy || !selected} onClick={() => void attach({ canvasId: selected })}>
          Attach
        </button>
      </div>
      <button type="button" className="inbox-attach-create" disabled={busy} onClick={() => void attach({})}>
        Create canvas from this chat
      </button>
      {error && <small className="inbox-attach-error">{error}</small>}
    </div>
  );
}

function ItemRow({ item, selected, onOpen }: { item: InboxItem; selected: boolean; onOpen: () => void }) {
  const badge =
    item.waitingOn === 'human' ? (
      <span className="inbox-badge">waiting</span>
    ) : item.status === 'closed' ? (
      <span className="inbox-badge closed">closed</span>
    ) : null;

  return (
    <div className={`inbox-item${selected ? ' sel' : ''}`} onClick={onOpen}>
      <div className="inbox-item-top">
        {item.unread && <span className="inbox-dot" aria-label="unread" />}
        <b>{item.summary || item.id}</b>
        {item.kind === 'dev-agent' && <span className="inbox-badge dev-agent">dev-agent</span>}
        {badge}
      </div>
      <small>{preview(item)}</small>
    </div>
  );
}

// One open Conversation, now a LIVE <ChatView> over its owning bridge (ADR-0009 / #124), plus a
// Close/Reopen toggle. Opening resolves the chatId from the bridge (`GET .../api/inbox/:id/chat`
// through the proxy) — which WAKES the runner and restores its JSONL if cold — then points the
// chat-store connection target at the proxy and mounts <ChatView>. That one component streams the
// transcript + reply and handles image paste, the SAME as the canvas. Keyed by conversation id in
// the parent, so switching conversations remounts (fresh resolve). The transcript is no longer an
// edge R2 read; browsing the list never reaches here (only opening does).
function Thread({
  item,
  onListReload,
  canvasHidden,
  onToggleCanvas,
}: {
  item: InboxItem;
  onListReload: () => Promise<void>;
  canvasHidden: boolean;
  onToggleCanvas: () => void;
}) {
  const id = item.id;
  const prefix = bridgePrefix(id);
  const [chatId, setChatId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'waking' | 'error' | 'ready'>('waking');
  const [status, setStatus] = useState<'open' | 'closed'>(item.status);

  // Resolve the chatId from the owning bridge (through the proxy). This is the cold-boot wake:
  // the bridge restores the session JSONL from R2 if needed and returns the chatId to subscribe
  // to. Set the connection target BEFORE mounting <ChatView> so its stream opens under the proxy.
  useEffect(() => {
    let live = true;
    setPhase('waking');
    (async () => {
      const r = await fetch(`${prefix}/api/inbox/${encodeURIComponent(id)}/chat`, {
        credentials: 'same-origin',
      }).catch(() => null);
      if (!live) return;
      if (!r?.ok) {
        setPhase('error');
        return;
      }
      const d = (await r.json()) as InboxChatResponse;
      setConnectionTarget(d.chatId, prefix);
      setChatId(d.chatId);
      setPhase('ready');
    })();
    return () => {
      live = false;
    };
  }, [id, prefix]);

  const toggle = async () => {
    const action = status === 'closed' ? 'reopen' : 'close';
    const r = await fetch(`/api/inbox/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => null);
    if (r?.ok) setStatus(action === 'close' ? 'closed' : 'open');
    await onListReload();
  };

  return (
    <>
      <div className="inbox-threadhead">
        <b>{item.summary || id}</b>
        <button
          type="button"
          className="inbox-canvas-toggle"
          aria-label={canvasHidden ? 'Show canvas' : 'Hide canvas'}
          onClick={onToggleCanvas}
        >
          {canvasHidden ? '⇤' : '⇥'}
        </button>
        <button type="button" onClick={() => void toggle()}>
          {status === 'closed' ? 'Reopen' : 'Close'}
        </button>
      </div>
      {phase === 'error' ? (
        <div className="inbox-empty">Failed to open conversation.</div>
      ) : phase === 'waking' || !chatId ? (
        <div className="inbox-empty">Waking the conversation…</div>
      ) : (
        <div className="inbox-chatview">
          <ChatView chatId={chatId} title={item.summary || id} />
        </div>
      )}
    </>
  );
}
