import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ChatEvent,
  InboxConversation,
  InboxDetailResponse,
  InboxItem,
  InboxListResponse,
  StatusFilter,
} from './contract';

// The Inbox stage: a React port of the retired edge-rendered `INBOX_HTML` (worker/shell.ts),
// now the `stage === 'inbox'` case of the Shell so it lives under the ONE chrome (the rail)
// instead of drawing its own header. Same two panes and same edge API (`/api/inbox*`,
// unchanged): a left list of the user's Conversations (waiting_on:human badged, unread dot,
// status + workspace filters) and a right thread rendered from the R2 transcript — so
// browsing never wakes the container; only a reply does (that's the edge's job, not ours).

/** The list preview mirrors the old page: last message, else the summary. */
const preview = (it: InboxItem): string => it.lastMessagePreview ?? it.summary ?? '';

export function InboxStage() {
  const [status, setStatus] = useState<StatusFilter>('open');
  const [workspace, setWorkspace] = useState('');
  const [items, setItems] = useState<InboxItem[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [current, setCurrent] = useState<string | null>(null);

  // The list is a pure function of the two filters, so re-query whenever either changes —
  // this is what makes a status change re-fetch `/api/inbox?status=…`.
  const loadList = useCallback(async () => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (workspace) qs.set('workspace', workspace);
    const q = qs.toString();
    const r = await fetch(`/api/inbox${q ? `?${q}` : ''}`, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      setItems([]);
      setState('error');
      return;
    }
    const d = (await r.json()) as InboxListResponse;
    setItems(d.items);
    setState('ready');
  }, [status, workspace]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Workspace options come from the loaded list (the old page derived them the same way),
  // plus the current selection so it survives a re-query that filters the list down to it.
  const workspaceOptions = useMemo(() => {
    const set = new Set(items.map((i) => i.workspaceId));
    if (workspace) set.add(workspace);
    return [...set];
  }, [items, workspace]);

  return (
    <div className="shell-stage stage-inbox">
      <div className="inbox-list">
        <div className="inbox-filters">
          <select
            aria-label="Status filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="">All</option>
          </select>
          <select aria-label="Workspace filter" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">All workspaces</option>
            {workspaceOptions.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
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
              <ItemRow key={it.id} item={it} selected={current === it.id} onOpen={() => setCurrent(it.id)} />
            ))
          )}
        </div>
      </div>
      <div className="inbox-thread">
        {current ? (
          <Thread key={current} id={current} onListReload={loadList} />
        ) : (
          <div className="inbox-empty">Select a conversation.</div>
        )}
      </div>
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
        {badge}
      </div>
      <small>{preview(item)}</small>
    </div>
  );
}

// One open Conversation: its transcript (read from R2 by the edge, so it renders while the
// runner sleeps), a Close/Reopen toggle, and a reply box. Keyed by conversation id in the
// parent so switching conversations remounts it (fresh fetch + cleared draft).
function Thread({ id, onListReload }: { id: string; onListReload: () => Promise<void> }) {
  const [conversation, setConversation] = useState<InboxConversation | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [sending, setSending] = useState(false);
  // The reply box is uncontrolled (read on send, cleared on success), mirroring the old page
  // which read `msg.value` straight off the DOM — no per-keystroke re-render of the thread.
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/inbox/${encodeURIComponent(id)}`, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      setState('error');
      return;
    }
    const d = (await r.json()) as InboxDetailResponse;
    setConversation(d.conversation);
    setEvents(d.events ?? []);
    setState('ready');
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    if (!conversation) return;
    const action = conversation.status === 'closed' ? 'reopen' : 'close';
    await fetch(`/api/inbox/${encodeURIComponent(id)}/${action}`, { method: 'POST', credentials: 'same-origin' }).catch(
      () => {},
    );
    await onListReload();
    await load();
  };

  const send = async () => {
    const el = replyRef.current;
    const text = el?.value.trim() ?? '';
    if (!text) return;
    setSending(true);
    const r = await fetch(`/api/inbox/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text }),
    }).catch(() => null);
    setSending(false);
    if (r?.ok) {
      if (el) el.value = '';
      await onListReload();
      await load();
    }
  };

  if (state === 'loading') return <div className="inbox-empty">Loading…</div>;
  if (state === 'error' || !conversation) return <div className="inbox-empty">Failed to load conversation.</div>;

  const closed = conversation.status === 'closed';
  return (
    <>
      <div className="inbox-threadhead">
        <b>{conversation.summary || conversation.sessionId}</b>
        <button type="button" onClick={() => void toggle()}>
          {closed ? 'Reopen' : 'Close'}
        </button>
      </div>
      <div className="inbox-events">
        {events.length === 0 ? (
          <div className="inbox-empty">No history yet.</div>
        ) : (
          events.map((ev, i) => <EventRow key={i} event={ev} />)
        )}
      </div>
      <div className="inbox-reply">
        <textarea ref={replyRef} aria-label="Reply" placeholder="Reply to the agent…" />
        <button type="button" disabled={sending} onClick={() => void send()}>
          Send
        </button>
      </div>
    </>
  );
}

// The three transcript event kinds the old page rendered, distinctly: a `delta` is a chat
// bubble (right-aligned for the human's own replay, left for the agent); a `tool` and a
// `thinking` are quiet meta lines. Every other kind is transcript noise the list omits.
function EventRow({ event }: { event: ChatEvent }) {
  if (event.kind === 'delta' && event.text) {
    const role = event.role === 'user' ? 'user' : 'assistant';
    return (
      <div className={`inbox-ev ${role}`}>
        <div className="inbox-bubble">{event.text}</div>
      </div>
    );
  }
  if (event.kind === 'tool') return <div className="inbox-ev meta">→ {event.name}</div>;
  if (event.kind === 'thinking') return <div className="inbox-ev meta">thinking…</div>;
  return null;
}
