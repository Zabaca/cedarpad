import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChatView } from '../../../shared/ChatView';
import { setConnectionTarget } from '../../../shared/chat-store';
import type { InboxChatResponse, InboxItem, InboxListResponse, InboxView } from './contract';

// The Inbox stage (ADR-0009 / #124): the `stage === 'inbox'` case of the Shell, under the ONE
// chrome (the rail). Two panes over the edge API: a left LIST of the user's Conversations
// (Turso only — waiting_on:human badged, unread dot, status + workspace filters, never wakes a
// runner) and a right THREAD that is now a LIVE <ChatView> over the Conversation's OWNING bridge
// (through the /inbox/:id/bridge proxy) — streaming transcript + reply + image paste, the SAME
// component the canvas renders. Only OPENING a conversation wakes its runner; browsing does not.

/** The edge chat proxy prefix a Conversation's <ChatView> addresses its owning bridge through. */
const bridgePrefix = (convId: string): string => `/inbox/${encodeURIComponent(convId)}/bridge`;

/** The list preview mirrors the old page: last message, else the summary. */
const preview = (it: InboxItem): string => it.lastMessagePreview ?? it.summary ?? '';

export function InboxStage() {
  // The unified session index: "Needs me" (default) = the attention subset (ask_human promotions);
  // "All" = every session (canvas chats, dev-agent runs); "Closed" = the archive.
  const [view, setView] = useState<InboxView>('needs-me');
  const [workspace, setWorkspace] = useState('');
  const [items, setItems] = useState<InboxItem[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  // The opened Conversation (the whole item, so the thread keeps its summary/status even after a
  // close drops it from the filtered list). null = nothing open.
  const [current, setCurrent] = useState<InboxItem | null>(null);

  // The list is a pure function of the two filters, so re-query whenever either changes —
  // this is what makes a view change re-fetch `/api/inbox?view=…`.
  const loadList = useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set('view', view);
    if (workspace) qs.set('workspace', workspace);
    const r = await fetch(`/api/inbox?${qs.toString()}`, { credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      setItems([]);
      setState('error');
      return;
    }
    const d = (await r.json()) as InboxListResponse;
    setItems(d.items);
    setState('ready');
  }, [view, workspace]);

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
            aria-label="View filter"
            value={view}
            onChange={(e) => setView(e.target.value as InboxView)}
          >
            <option value="needs-me">Needs me</option>
            <option value="all">All sessions</option>
            <option value="closed">Closed</option>
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
              <ItemRow key={it.id} item={it} selected={current?.id === it.id} onOpen={() => setCurrent(it)} />
            ))
          )}
        </div>
      </div>
      <div className="inbox-thread">
        {current ? (
          <Thread key={current.id} item={current} onListReload={loadList} />
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

// One open Conversation, now a LIVE <ChatView> over its owning bridge (ADR-0009 / #124), plus a
// Close/Reopen toggle. Opening resolves the chatId from the bridge (`GET .../api/inbox/:id/chat`
// through the proxy) — which WAKES the runner and restores its JSONL if cold — then points the
// chat-store connection target at the proxy and mounts <ChatView>. That one component streams the
// transcript + reply and handles image paste, the SAME as the canvas. Keyed by conversation id in
// the parent, so switching conversations remounts (fresh resolve). The transcript is no longer an
// edge R2 read; browsing the list never reaches here (only opening does).
function Thread({ item, onListReload }: { item: InboxItem; onListReload: () => Promise<void> }) {
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
