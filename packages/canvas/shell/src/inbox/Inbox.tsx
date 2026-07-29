import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';

import { ChatView } from '../../../shared/ChatView';
import { onChatFrame, openFrameSignal, setChatKind, setConnectionTarget } from '../../../shared/chat-store';
import { DEV_AGENT_CHAT_KIND } from '../../../shared/bridge-wire';
import type { InboxChatResponse, InboxItem, InboxListResponse, InboxView } from './contract';
import { padUrlFor } from './inbox-pad-url';
import { thirdPane } from './inbox-third-pane';
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
// (D1 only, SCOPED SERVER-SIDE to the active workspace — waiting_on:human badged, unread dot,
// status filter, never wakes a runner), a THREAD that is a LIVE <ChatView> over the
// Conversation's OWNING bridge (through the /inbox/:id/bridge proxy) — streaming transcript +
// reply + image paste, the SAME component the canvas renders — and, once a conversation is open,
// a third CANVAS pane: the chat→canvas edge (`InboxItem.canvasId`, worker/inbox-view.ts) rendered
// as the same live same-origin Render Pad iframe `CanvasStage` mounts, or a placeholder when
// nothing's linked yet. Only OPENING a conversation wakes its runner; browsing does not.
// The pane widths + the canvas-pane visibility are per-device UI prefs, persisted to
// localStorage (`inbox-panes.ts` owns the pure clamp/serialize logic).

/** Sticky collapse state for the conversation-list pane. */
const LIST_COLLAPSED_KEY = 'inbox.list.collapsed';

// Chat kind (CEDA-N67Y50). A new chat is born as one of two KINDs — an ordinary `chat`, or a
// `dev-agent` chat (repo-aware, `open_pr` armed; ADR-0010/0011). Until now only a Job run could
// produce the latter, so the Inbox could start ordinary chats only. The kind is declared on the
// draft's first send, which is what births the row; the last pick is sticky per device, so the
// primary button stays one click for whichever kind you actually work in.
const CHAT_KIND_KEY = 'inbox.new-chat.kind';
type ChatKind = 'chat' | typeof DEV_AGENT_CHAT_KIND;
const CHAT_KINDS: Array<{ kind: ChatKind; label: string; blurb: string }> = [
  { kind: 'chat', label: 'Chat', blurb: 'Talk to the workspace agent' },
  { kind: DEV_AGENT_CHAT_KIND, label: 'Dev-agent', blurb: 'Reads the repo, can open a PR' },
];
const parseChatKind = (raw: string | null): ChatKind => (raw === DEV_AGENT_CHAT_KIND ? DEV_AGENT_CHAT_KIND : 'chat');

/** The edge chat proxy prefix a Conversation's <ChatView> addresses its owning bridge through. */
const bridgePrefix = (convId: string): string => `/inbox/${encodeURIComponent(convId)}/bridge`;

/** The list preview mirrors the old page: last message, else the summary. */
const preview = (it: InboxItem): string => it.lastMessagePreview ?? it.summary ?? '';

/** One roster row (worker/members.ts GET) — the assignee filter's options + chip names. */
type Member = { userId: string; name: string; email: string; role: 'owner' | 'member' };

export function InboxStage({ workspaceId }: { workspaceId?: string } = {}) {
  // Filters + selection are URL-persisted: a reload lands back on the same view/selected
  // conversation, the same spirit as stage.ts. Parsed once, lazily, on mount.
  const [initialUrlState] = useState(() => inboxStateFromUrl(window.location.search));
  // The unified session index, scoped server-side to the active workspace: "Open" (default) =
  // every open session; "All" = every session (canvas chats, dev-agent runs, open and closed);
  // "Closed" = the archive. The waiting_on:human pinning (worker/inbox-view.ts `orderInbox`)
  // still surfaces attention at the top of Open.
  const [view, setView] = useState<InboxView>(initialUrlState.view);
  // The "Assigned to" facet (shared inbox): null = Everyone (default), 'unassigned' = the
  // unclaimed queue, else a member's userId. Composes with the view.
  const [assigned, setAssigned] = useState<string | null>(null);
  // The active workspace's roster: the filter's options + the name behind each row's chip.
  const [members, setMembers] = useState<Member[]>([]);
  // The caller's user id (from the list response) — drives the Private toggle's creator check.
  const [me, setMe] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  // The opened Conversation (the whole item, so the thread keeps its summary/status even after a
  // close drops it from the filtered list). null = nothing open.
  const [current, setCurrent] = useState<InboxItem | null>(null);
  // A DRAFT chat started from the Inbox (no Conversation row yet): a fresh client-minted
  // chatId whose <ChatView> talks same-origin (the edge fall-through proxies /api/chat/* to
  // the active workspace's bridge). The first send's row-at-start creates the Conversation
  // (ownerRef = this chatId); the next list load matches it back and promotes draft → current.
  const [draft, setDraft] = useState<string | null>(null);
  // The kind the next new chat is born as, and whether the split button's menu is open.
  const [newChatKind, setNewChatKind] = useState<ChatKind>(() => parseChatKind(localStorage.getItem(CHAT_KIND_KEY)));
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  // A `conv` named in the URL on mount is selected once the (async) list loads and contains it —
  // it may live in a different view than the one showing; cleared after the first load attempt
  // whether or not it matched, since after that the selection is user-driven.
  const pendingConvId = useRef(initialUrlState.conv);
  // Mirror of `draft` for loadList (which is memoized on the filters only).
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;

  // Column management (drag-to-resize + canvas-pane toggle): per-device UI prefs, restored from
  // localStorage on mount.
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => parsePaneWidths(localStorage.getItem(PANE_WIDTHS_KEY)));
  const [canvasHidden, setCanvasHidden] = useState(() => parseCanvasHidden(localStorage.getItem(CANVAS_HIDDEN_KEY)));
  // Collapse the conversation list to a slim strip (full-width thread/canvas). Sticky per device.
  const [listCollapsed, setListCollapsed] = useState(() => localStorage.getItem(LIST_COLLAPSED_KEY) === '1');
  useEffect(() => {
    try {
      localStorage.setItem(LIST_COLLAPSED_KEY, listCollapsed ? '1' : '0');
    } catch {
      /* storage unavailable: skip */
    }
  }, [listCollapsed]);

  // The list is a pure function of the view filter, so re-query whenever it changes — this is
  // what makes a view change re-fetch `/api/inbox?view=…`. No `workspace` param: the list is
  // scoped server-side to the active workspace (the `cs_workspace` cookie, worker/inbox.ts).
  const loadList = useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set('view', view);
    if (assigned) qs.set('assigned', assigned);
    const r = await fetch(`/api/inbox?${qs.toString()}`, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      setItems([]);
      setState('error');
      return;
    }
    const d = (await r.json()) as InboxListResponse;
    setItems(d.items);
    if (d.me) setMe(d.me);
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
    // Draft promotion: the first send created the row (ownerRef = the draft chatId) — select
    // it so the thread becomes a normal Conversation (URL-persisted, closable, attachable).
    if (draftRef.current) {
      const born = d.items.find((it) => it.ownerRef === draftRef.current);
      if (born) {
        setCurrent(born);
        setDraft(null);
      }
    }
    // Open the doorbell stream through any conversation's bridge proxy (they all resolve to
    // the warm default container, whose chat stream broadcasts every chat's frames).
    // Idempotent: the shared stream is a singleton.
    if (d.items[0]) openFrameSignal(bridgePrefix(d.items[0].id));
  }, [view, assigned]);

  // The roster, once per active workspace: powers the filter's member options and the chips.
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ members: Member[] }>) : null))
      .then((d) => {
        if (alive && d) setMembers(d.members);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspaceId]);

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
    // refetch of the authoritative D1 list. A slow poll + tab-return refetch stay as the
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

  // Start a draft chat: a client-minted chatId, no row and no request. The first send births the
  // Conversation on the active workspace's bridge; loadList promotes it (see draft promotion).
  // Pressing it again while a draft is already open REUSES it — a second press must never discard
  // a half-typed message by remounting <ChatView> on a fresh id.
  const startDraft = useCallback((kind: ChatKind = newChatKind) => {
    setKindMenuOpen(false);
    setNewChatKind(kind);
    try {
      localStorage.setItem(CHAT_KIND_KEY, kind);
    } catch {
      /* storage unavailable: the pick just isn't sticky */
    }
    setCurrent(null);
    setDraft((d) => {
      const id = d ?? `chat_${crypto.randomUUID()}`;
      // Declare it on the chat itself, not on this component's state: `send()` reads it when the
      // draft's first message births the Conversation. Re-declared on a re-pick (null for the
      // ordinary default), so switching kind mid-draft applies without discarding a half-typed
      // message.
      setChatKind(id, kind === DEV_AGENT_CHAT_KIND ? kind : null);
      return id;
    });
  }, [newChatKind]);

  // ⌘N / Ctrl+N starts a draft from anywhere in the stage. Ignored when the browser's own
  // modifier combo is in play (Alt) so we never shadow a native shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || e.altKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      startDraft();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [startDraft]);

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
      {listCollapsed ? (
        <div className="inbox-list collapsed">
          <button type="button" className="panel-collapse" title="Show conversations" onClick={() => setListCollapsed(false)}>
            »
          </button>
        </div>
      ) : (
      <div className="inbox-list" style={{ width: paneWidths.list, flex: 'none' }}>
        {/* The split entry point (CEDA-N67Y50): one click on the primary button starts a chat of
            the current kind — unchanged for anyone who never touches the caret — and the caret
            opens the two-kind menu. */}
        <div className="inbox-newrow">
          <div className="inbox-newsplit">
            <button
              type="button"
              className="inbox-new-chat"
              title={newChatKind === DEV_AGENT_CHAT_KIND ? 'Start a new dev-agent chat' : 'Start a new chat'}
              onClick={() => startDraft()}
            >
              + New {newChatKind === DEV_AGENT_CHAT_KIND ? 'dev-agent chat' : 'chat'}
            </button>
            <button
              type="button"
              className="inbox-new-kind"
              aria-label="Choose chat kind"
              aria-expanded={kindMenuOpen}
              title="Choose chat kind"
              onClick={() => setKindMenuOpen((o) => !o)}
            >
              ▾
            </button>
          </div>
        </div>
        {kindMenuOpen && (
          <div className="inbox-kind-menu">
            {CHAT_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                className={k.kind === newChatKind ? 'on' : undefined}
                onClick={() => startDraft(k.kind)}
              >
                <b>{k.label}</b>
                <small>{k.blurb}</small>
              </button>
            ))}
          </div>
        )}
        <div className="inbox-filters">
          <button type="button" className="panel-collapse" title="Hide conversations (full thread)" onClick={() => setListCollapsed(true)}>
            «
          </button>
          <select aria-label="View filter" value={view} onChange={(e) => setView(e.target.value as InboxView)}>
            <option value="open">Open</option>
            <option value="all">All sessions</option>
            <option value="closed">Closed</option>
          </select>
          <select
            aria-label="Assignee filter"
            value={assigned ?? ''}
            onChange={(e) => setAssigned(e.target.value || null)}
          >
            <option value="">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="inbox-items">
          {state === 'error' ? (
            <div className="inbox-empty">Failed to load.</div>
          ) : state === 'loading' ? (
            <div className="inbox-empty">Loading…</div>
          ) : items.length === 0 && !draft ? (
            <div className="inbox-empty">No conversations.</div>
          ) : (
            <>
              {/* Row zero: the draft, pinned above every real Conversation and badged so it reads
                  as not-yet-saved. It survives filter changes and a list refetch that has not
                  borne it yet; the promotion in loadList is what clears it. */}
              {draft && (
                <div className="inbox-item draft sel">
                  <div className="inbox-item-top">
                    <b>New chat</b>
                    {newChatKind === DEV_AGENT_CHAT_KIND && <span className="inbox-badge dev-agent">dev-agent</span>}
                    <span className="inbox-badge">draft</span>
                  </div>
                  <small>Not saved until you send.</small>
                </div>
              )}
              {items.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  assigneeName={members.find((m) => m.userId === it.assignedTo)?.name}
                  selected={current?.id === it.id}
                  onOpen={() => {
                    setDraft(null);
                    setCurrent(it);
                  }}
                />
              ))}
            </>
          )}
        </div>
      </div>
      )}
      {!listCollapsed && <div className="inbox-divider" onPointerDown={startResize('list')} />}
      <div className="inbox-thread" style={showCanvas ? { flex: `0 0 ${paneWidths.thread}px` } : undefined}>
        {current ? (
          <Thread
            key={current.id}
            item={current}
            me={me}
            onListReload={loadList}
            canvasHidden={canvasHidden}
            onToggleCanvas={toggleCanvas}
          />
        ) : draft ? (
          // The draft thread: a live same-origin <ChatView> on a chat that has no
          // Conversation row yet. The first send births the row on the active workspace's
          // bridge; loadList promotes it to `current` (see draft promotion above).
          <>
            <div className="inbox-threadhead">
              <b>New chat</b>
            </div>
            <div className="inbox-chatview">
              <ChatView key={draft} chatId={draft} title="New chat" />
            </div>
          </>
        ) : (
          <div className="inbox-empty">Select a conversation.</div>
        )}
      </div>
      {showCanvas && current && (
        <>
          <div className="inbox-divider" onPointerDown={startResize('thread')} />
          <ThirdPane item={current} onAttached={loadList} onMerged={loadList} />
        </>
      )}
    </div>
  );
}

// The third pane. It used to be the linked canvas alone; a dev-agent run with an open PR now
// takes the same slot (CONTEXT.md "Open PR") — the run's durable artifact deserves the space
// the canvas gets, and merging is the one action you cannot take anywhere else in the app.
// `thirdPane` owns which of the three shows and whether there is anything to switch between;
// the human's pick is per-conversation state, so it never leaks across rows.
function ThirdPane({ item, onAttached, onMerged }: { item: InboxItem; onAttached: () => void; onMerged: () => Promise<void> }) {
  const [preferred, setPreferred] = useState<'pr' | 'canvas' | null>(null);
  const { show, canToggle } = thirdPane(item, preferred);
  const padUrl = padUrlFor(item);

  return (
    <div className="inbox-canvas">
      {canToggle && (
        <div className="inbox-pane-switch">
          <button type="button" className={show === 'pr' ? 'on' : undefined} onClick={() => setPreferred('pr')}>
            PR
          </button>
          <button type="button" className={show === 'canvas' ? 'on' : undefined} onClick={() => setPreferred('canvas')}>
            Canvas
          </button>
        </div>
      )}
      {show === 'pr' ? (
        <PrPane key={`${item.id}:pr`} item={item} onMerged={onMerged} />
      ) : show === 'canvas' && padUrl ? (
        <iframe key={`${item.id}:${item.canvasId}`} className="inbox-canvas-frame" title="canvas" src={padUrl} />
      ) : (
        <AttachPanel key={item.id} item={item} onAttached={onAttached} />
      )}
    </div>
  );
}

// The PR the run opened, and the one thing you want to do with it. Merging is an edge act
// (`POST /api/inbox/:id/merge`, ADR-0008 — the App key never leaves the edge): it squash-
// merges, stamps the row and closes the conversation in one call, so a success is simply a
// list reload away from being visible everywhere. A refusal shows GitHub's own words and
// leaves the button live, because the usual cause is a check that is about to go green.
function PrPane({ item, onMerged }: { item: InboxItem; onMerged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local echo of the merge, exactly as the thread head keeps its own Close/Reopen state:
  // merging CLOSES the conversation, so the refreshed list no longer carries this row in the
  // Open view and `current` keeps its pre-merge snapshot. Without this the pane would still
  // offer to merge something already merged.
  const [justMerged, setJustMerged] = useState(false);
  const merged = !!item.prMergedAt || justMerged;
  const prUrl = item.prUrl ?? '';
  const number = /\/pull\/(\d+)/.exec(prUrl)?.[1];

  const merge = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/inbox/${encodeURIComponent(item.id)}/merge`, {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'Merge failed.');
      setBusy(false);
      return;
    }
    setJustMerged(true);
    // The row now carries the merge stamp and has left the Open view; the refetch moves the
    // list on (this pane is already the receipt).
    await onMerged();
    setBusy(false);
  };

  return (
    <div className="inbox-pr">
      <div className="inbox-pr-head">
        <span className="inbox-pr-num">{number ? `#${number}` : 'Pull request'}</span>
        <span className={`inbox-badge pr${merged ? ' merged' : ''}`}>{merged ? 'merged' : 'open'}</span>
      </div>
      <div className="inbox-pr-body">
        {item.repo && <div className="inbox-pr-repo">{item.repo}</div>}
        <a className="inbox-pr-link" href={prUrl} target="_blank" rel="noreferrer">
          {prUrl}
        </a>
        {merged && <div className="inbox-pr-merged">Merged — this run is done.</div>}
      </div>
      <div className="inbox-pr-actions">
        {!merged && (
          <button type="button" className="inbox-pr-merge" disabled={busy} onClick={() => void merge()}>
            {busy ? 'Merging…' : 'Squash & merge'}
          </button>
        )}
        <a className="inbox-pr-review" href={prUrl} target="_blank" rel="noreferrer">
          Review on GitHub ↗
        </a>
        {error && <small className="inbox-pr-error">{error}</small>}
      </div>
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

function ItemRow({
  item,
  assigneeName,
  selected,
  onOpen,
}: {
  item: InboxItem;
  /** The assignee's display name from the roster (chip title); falls back to the raw id. */
  assigneeName?: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const badge =
    item.waitingOn === 'human' ? (
      <span className="inbox-badge">waiting</span>
    ) : item.status === 'closed' ? (
      <span className="inbox-badge closed">closed</span>
    ) : null;
  const assignee = item.assignedTo ? (assigneeName ?? item.assignedTo) : null;

  return (
    <div className={`inbox-item${selected ? ' sel' : ''}`} onClick={onOpen}>
      <div className="inbox-item-top">
        {item.unread && <span className="inbox-dot" aria-label="unread" />}
        <b>{item.summary || item.id}</b>
        {item.visibility === 'private' && (
          <span className="inbox-private" title="Private — only you see this chat" aria-label="private">
            🔒
          </span>
        )}
        {item.kind === 'dev-agent' && <span className="inbox-badge dev-agent">dev-agent</span>}
        {badge}
        {assignee && (
          <span className="inbox-assignee" title={assignee} aria-label={`Assigned to ${assignee}`}>
            {assignee.slice(0, 1).toUpperCase()}
          </span>
        )}
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
  me,
  onListReload,
  canvasHidden,
  onToggleCanvas,
}: {
  item: InboxItem;
  /** The caller's user id — the Private toggle shows only for the chat's creator (ADR-0016). */
  me: string | null;
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
        {me && item.createdBy === me && (
          <button
            type="button"
            title={
              item.visibility === 'private'
                ? 'Private — only you see this chat. Click to share with the workspace.'
                : 'Shared with the workspace. Click to make private.'
            }
            onClick={() =>
              void (async () => {
                await fetch(`/api/inbox/${encodeURIComponent(id)}/visibility`, {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ visibility: item.visibility === 'private' ? 'shared' : 'private' }),
                }).catch(() => {});
                await onListReload();
              })()
            }
          >
            {item.visibility === 'private' ? '🔒 Private' : '🔓 Shared'}
          </button>
        )}
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
