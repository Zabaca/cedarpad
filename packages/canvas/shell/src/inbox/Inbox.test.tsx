// happy-dom's window/document must register BEFORE the component tree imports (shared with
// the canvas + Shell tests — it preserves Bun's native fetch/Response, which we stub here).
import '../../../src/happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { connectionTarget, send } from '../../../shared/chat-store';
import { InboxStage } from './Inbox';

// A minimal in-memory edge for the Inbox stage. The LIST is D1-only (`/api/inbox*`), scoped
// server-side to the active workspace (no client-sent `?workspace=` anymore — worker/inbox.ts
// resolves it from the `cs_workspace` cookie), and must never wake a runner. OPENING a
// Conversation is a live <ChatView> over the owning bridge via the edge proxy (ADR-0009 / #124):
// the Shell first resolves the chatId from `GET /inbox/:id/bridge/api/inbox/:id/chat` (the ONLY
// wake), sets the chat-store connection target to that proxy prefix, and mounts <ChatView> —
// which then talks to the bridge under the prefix (transcript/stream/send). Every request is
// recorded so we can assert (a) that browsing the list touches ONLY `/api/inbox*` (no `/bridge`
// wake) and (b) that opening points <ChatView> at the proxy.

type Item = {
  id: string;
  status: 'open' | 'closed';
  waitingOn: 'human' | 'agent' | 'none';
  kind: 'chat' | 'dev-agent';
  unread: boolean;
  summary: string | null;
  lastMessagePreview: string | null;
  workspaceId: string;
  lastActivity: number;
  canvasId: string | null;
  assignedTo: string | null;
  /** The chatId that birthed the row — how a draft is matched back to its Conversation. */
  ownerRef?: string;
  /** The run's PR state (CONTEXT.md "Open PR") — what the merge action is rendered from. */
  repo?: string | null;
  prUrl?: string | null;
  prMergedAt?: number | null;
};

const realFetch = globalThis.fetch;
let calls: string[] = [];
let store: Item[] = [];
/** Every same-origin chat SEND, with the chat-kind the client declared on it (CEDA-N67Y50). */
let sends: Array<{ url: string; kind: string | null }> = [];
/** When set, the stubbed merge route refuses with this as GitHub's reason. */
let mergeFails: string | null = null;

const item = (o: Partial<Item> & { id: string }): Item => ({
  status: 'open',
  waitingOn: 'none',
  kind: 'chat',
  unread: false,
  summary: o.id,
  lastMessagePreview: null,
  workspaceId: 'ws_1',
  lastActivity: 0,
  canvasId: null,
  assignedTo: null,
  repo: null,
  prUrl: null,
  prMergedAt: null,
  ...o,
});

/** The chatId the bridge resolves a Conversation to (`chatIdForSession(sessionId) ?? conv.id`). */
const chatIdFor = (convId: string) => `chat_${convId}`;

function stubInbox() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const u = new URL(url, 'https://poc.cedarpad.com');
    if (method === 'POST' && u.pathname.endsWith('/send')) {
      sends.push({ url, kind: new Headers(init?.headers).get('x-chat-kind') });
      return Response.json({ ok: true });
    }

    // GET /api/inbox?view=  — the edge list (D1, no wake; server-side workspace-scoped, no
    // client ?workspace= param). view maps to the same status filter the edge's
    // viewToListOpts applies.
    if (u.pathname === '/api/inbox' && method === 'GET') {
      const view = u.searchParams.get('view') ?? 'open';
      const assigned = u.searchParams.get('assigned');
      const items = store
        .filter((it) => (view === 'closed' ? it.status === 'closed' : view === 'all' ? true : it.status === 'open'))
        .filter((it) => (assigned ? (assigned === 'unassigned' ? it.assignedTo === null : it.assignedTo === assigned) : true));
      return Response.json({ items });
    }

    // The workspace roster (the "Assigned to" filter options + name lookup for chips).
    if (/^\/api\/workspaces\/[^/]+\/members$/.test(u.pathname) && method === 'GET') {
      return Response.json({
        members: [
          { userId: 'u_james', name: 'James Lee', email: 'james@example.com', role: 'owner' },
          { userId: 'u_sam', name: 'Sam Poder', email: 'sam@example.com', role: 'member' },
        ],
      });
    }

    // Edge chat proxy: /inbox/:id/bridge/*  — the owning runner bridge.
    const bridge = /^\/inbox\/([^/]+)\/bridge(\/.*)$/.exec(u.pathname);
    if (bridge) {
      const convId = bridge[1] as string;
      const sub = bridge[2] as string;
      // The chatId resolve (the wake): restore + `chatIdForSession(sessionId) ?? conv.id`.
      if (sub === `/api/inbox/${convId}/chat`) return Response.json({ chatId: chatIdFor(convId) });
      // <ChatView>'s rehydrate on connect (JSONL-derived transcript under the proxy prefix).
      if (sub.endsWith('/transcript')) return Response.json({ config: {}, events: [] });
      return Response.json({ ok: true });
    }

    // Merge — the edge lands the run's PR, stamps it merged and closes the row in one act.
    const mergeRoute = /^\/api\/inbox\/([^/]+)\/merge$/.exec(u.pathname);
    if (mergeRoute && method === 'POST') {
      const row = store.find((r) => r.id === mergeRoute[1]);
      if (mergeFails) return Response.json({ error: mergeFails }, { status: 409 });
      if (row) {
        row.prMergedAt = 1234;
        row.status = 'closed';
      }
      return Response.json({ conversation: row });
    }

    // Close / reopen — edge store transitions (no transcript, no wake).
    const m = /^\/api\/inbox\/([^/]+)\/(close|reopen)$/.exec(u.pathname);
    if (m) {
      const id = m[1] as string;
      const action = m[2];
      const row = store.find((it) => it.id === id);
      if (row) row.status = action === 'close' ? 'closed' : 'open';
      return Response.json({ conversation: row });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

// <ChatView> opens ONE shared SSE stream (chat-store) on mount; happy-dom has no EventSource, so
// stub a no-op that reports "open" (which flips the chat's `subscribed` gate) without a socket.
class StubEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<InboxStage workspaceId="ws_1" />);
  });
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
};

const changeSelect = async (el: Element | null, value: string) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLSelectElement).value = value;
    (el as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};

const items = () => [...container.querySelectorAll('.inbox-item')];
const viewFilter = () => container.querySelector('[aria-label="View filter"]');

beforeEach(() => {
  calls = [];
  sends = [];
  mergeFails = null;
  store = [];
  stubInbox();
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown;
  // Give the document a real origin so pushState (relative URL) resolves under happy-dom, whose
  // default document is about:blank (origin null) — same fix as Shell.test.tsx.
  (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL('https://poc.cedarpad.com/');
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

// The list is the ported left pane: it renders the edge list and re-queries on filter change.
// No workspace filter — the Inbox is scoped server-side to the active workspace.
describe('the inbox list', () => {
  test('defaults to the "Open" view — GET /api/inbox?view=open (no ?view= sent for the default)', async () => {
    store = [
      item({ id: 'c1', summary: 'Ship it', waitingOn: 'human' }),
      item({ id: 'c2', summary: 'idle chat', waitingOn: 'none' }),
      item({ id: 'c3', summary: 'archived', status: 'closed' }), // closed — hidden by the open default
    ];
    await mount();

    expect(calls).toContain('GET /api/inbox?view=open');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['Ship it', 'idle chat']);
  });

  test('"All sessions" shows every session, open and closed — no status filter', async () => {
    store = [
      item({ id: 'c1', summary: 'ask', waitingOn: 'human' }),
      item({ id: 'c2', summary: 'idle chat', waitingOn: 'none' }),
      item({ id: 'c3', summary: 'archived', status: 'closed', waitingOn: 'none' }),
    ];
    await mount();
    calls = [];

    await changeSelect(viewFilter(), 'all');
    expect(calls).toContain('GET /api/inbox?view=all');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['ask', 'idle chat', 'archived']);
  });

  test('"Closed" shows the archive', async () => {
    store = [item({ id: 'c1', status: 'open' }), item({ id: 'c2', summary: 'archived', status: 'closed' })];
    await mount();
    calls = [];

    await changeSelect(viewFilter(), 'closed');
    expect(calls).toContain('GET /api/inbox?view=closed');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['archived']);
  });

  test('there is no workspace filter — the select is gone', async () => {
    store = [item({ id: 'c1' })];
    await mount();
    expect(container.querySelector('[aria-label="Workspace filter"]')).toBeNull();
  });

  test('browsing the list never wakes a runner — it touches ONLY /api/inbox*', async () => {
    store = [item({ id: 'c1', waitingOn: 'human' }), item({ id: 'c2', waitingOn: 'human' })];
    await mount();
    await changeSelect(viewFilter(), 'all'); // filter around

    // No /inbox/:id/bridge/* call (that is the only wake path); the list is D1-only —
    // the workspace roster (the assignee filter's options) is an edge read too, never a wake.
    expect(calls.some((c) => c.includes('/bridge'))).toBe(false);
    expect(calls.every((c) => c.includes('/api/inbox') || /\/api\/workspaces\/[^/]+\/members/.test(c))).toBe(true);
  });
});

// The "Assigned to" filter (shared inbox): Everyone (default) / Unassigned / one entry per
// workspace member, composing with the view. Rows show an assignee chip (initial) when claimed.
describe('the assignee filter and chip', () => {
  const assigneeFilter = () => container.querySelector('[aria-label="Assignee filter"]');

  test('defaults to Everyone (no ?assigned= sent) and offers Unassigned + each member', async () => {
    store = [item({ id: 'c1' })];
    await mount();

    expect(calls).toContain('GET /api/inbox?view=open');
    const options = [...((assigneeFilter() as HTMLSelectElement)?.options ?? [])].map((o) => o.textContent);
    expect(options).toEqual(['Everyone', 'Unassigned', 'James Lee', 'Sam Poder']);
  });

  test('picking Unassigned / a member re-queries with ?assigned=', async () => {
    store = [item({ id: 'c1' }), item({ id: 'c2', assignedTo: 'u_james' })];
    await mount();
    calls = [];

    await changeSelect(assigneeFilter(), 'unassigned');
    expect(calls).toContain('GET /api/inbox?view=open&assigned=unassigned');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['c1']);

    calls = [];
    await changeSelect(assigneeFilter(), 'u_james');
    expect(calls).toContain('GET /api/inbox?view=open&assigned=u_james');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['c2']);
  });

  test('an assigned row renders the assignee chip (initial, full name as title); unassigned rows none', async () => {
    store = [item({ id: 'c1', assignedTo: 'u_james' }), item({ id: 'c2' })];
    await mount();

    const chips = [...container.querySelectorAll('.inbox-assignee')];
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('J');
    expect(chips[0]?.getAttribute('title')).toBe('James Lee');
  });
});

// The row decorations ported verbatim from INBOX_HTML's render(), plus the dev-agent badge
// (dev-agent rows now live in the `default` workspace, `kind: 'dev-agent'`, no special-casing).
describe('the item row badges and dot', () => {
  test('waiting_on:human renders the waiting badge', async () => {
    store = [item({ id: 'c1', waitingOn: 'human' })];
    await mount();
    const badge = container.querySelector('.inbox-badge');
    expect(badge?.textContent).toBe('waiting');
    expect(badge?.className).not.toContain('closed');
  });

  test('an unread item renders the dot', async () => {
    store = [item({ id: 'c1', unread: true, waitingOn: 'human' })];
    await mount();
    expect(container.querySelector('.inbox-dot')).not.toBeNull();
  });

  test('a closed item (not waiting) renders the closed badge', async () => {
    store = [item({ id: 'c1', status: 'closed', waitingOn: 'none' })];
    await mount();
    await changeSelect(viewFilter(), 'closed');
    const badge = container.querySelector('.inbox-badge');
    expect(badge?.textContent).toBe('closed');
    expect(badge?.className).toContain('closed');
  });

  test('a dev-agent row renders the dev-agent badge', async () => {
    store = [item({ id: 'c1', kind: 'dev-agent' })];
    await mount();
    const badge = container.querySelector('.inbox-badge.dev-agent');
    expect(badge?.textContent).toBe('dev-agent');
  });

  test('a plain chat row does not render the dev-agent badge', async () => {
    store = [item({ id: 'c1', kind: 'chat' })];
    await mount();
    expect(container.querySelector('.inbox-badge.dev-agent')).toBeNull();
  });
});

// The right pane is now the shared <ChatView>, connected to the owning bridge via the proxy.
describe('opening a conversation', () => {
  test('resolves the chatId from the bridge and mounts <ChatView> pointed at the proxy', async () => {
    store = [item({ id: 'c1', summary: 'Thread', waitingOn: 'human' })];
    await mount();
    await click(items()[0] ?? null);

    // The wake: it resolved the chatId through the proxy (never the retired R2 detail read).
    expect(calls).toContain('GET /inbox/c1/bridge/api/inbox/c1/chat');
    expect(calls).not.toContain('GET /api/inbox/c1'); // no edge transcript/detail read

    // <ChatView> is mounted (its card chrome), and its chat-store connection target for THIS
    // chatId is the proxy prefix — so its stream/send/transcript all address the owning bridge.
    expect(container.querySelector('.chat-card')).not.toBeNull();
    expect(connectionTarget(chatIdFor('c1'))).toBe('/inbox/c1/bridge');
  });

  test('the transcript rehydrate and stream open UNDER the proxy prefix (not same-origin)', async () => {
    store = [item({ id: 'c2', summary: 'Live', waitingOn: 'human' })];
    await mount();
    await click(items()[0] ?? null);

    // <ChatView>/chat-store pulled its transcript through the proxy, not from same-origin.
    expect(calls.some((c) => c.startsWith('GET /inbox/c2/bridge/api/chat/') && c.endsWith('/transcript'))).toBe(true);
  });
});

// Close/reopen still hit the edge store routes and refresh the list (no wake, no transcript read).
describe('thread actions', () => {
  test('Close posts /api/inbox/:id/close and the row leaves the open view', async () => {
    store = [item({ id: 'c1', summary: 'Close me', status: 'open', waitingOn: 'human' })];
    await mount();
    await click(items()[0] ?? null);

    const buttons = [...container.querySelectorAll('.inbox-threadhead button')];
    await click(buttons.find((b) => b.textContent === 'Close') ?? null);

    expect(calls).toContain('POST /api/inbox/c1/close');
    // The default "Open" view requires status:open; c1 is now closed, so it's gone from the list.
    expect(items()).toHaveLength(0);
  });
});

// Filters + selection are URL-persisted (mirrors stage.ts): a reload lands back on the same
// view/selected conversation.
describe('URL-persisted state', () => {
  test('mounting with ?view=all&conv=<id> restores the filter and selects that conversation once the list loads', async () => {
    store = [
      item({ id: 'c1', summary: 'archived', status: 'closed' }), // open view would hide this
    ];
    window.history.pushState(null, '', '/?stage=inbox&view=all&conv=c1');
    await mount();

    expect(calls).toContain('GET /api/inbox?view=all');
    expect((viewFilter() as HTMLSelectElement).value).toBe('all');
    // Selected once the async list loaded and contained it — the thread pane mounts <ChatView>.
    expect(container.querySelector('.chat-card')).not.toBeNull();
    expect(container.querySelector('.inbox-item.sel')?.querySelector('b')?.textContent).toBe('archived');
  });

  test('a legacy ?view=needs-me URL (the retired view) falls back to open', async () => {
    window.history.pushState(null, '', '/?stage=inbox&view=needs-me');
    store = [item({ id: 'c1' })];
    await mount();

    expect(calls).toContain('GET /api/inbox?view=open');
    expect((viewFilter() as HTMLSelectElement).value).toBe('open');
  });

  test('changing the view filter updates the URL (replaceState, stage= preserved)', async () => {
    window.history.pushState(null, '', '/?stage=inbox');
    store = [item({ id: 'c1', waitingOn: 'human' })];
    await mount();

    await changeSelect(viewFilter(), 'all');

    const params = new URLSearchParams(window.location.search);
    expect(params.get('stage')).toBe('inbox');
    expect(params.get('view')).toBe('all');
  });

  test('selecting a conversation adds ?conv=<id>; the default view is omitted from the URL', async () => {
    window.history.pushState(null, '', '/?stage=inbox');
    store = [item({ id: 'c1', summary: 'Thread', waitingOn: 'human' })];
    await mount();
    await click(items()[0] ?? null);

    const params = new URLSearchParams(window.location.search);
    expect(params.get('conv')).toBe('c1');
    expect(params.has('view')).toBe(false); // open is the default — kept out of the URL
  });
});

// The third pane: the conversation's linked canvas (`InboxItem.canvasId`, the chat→canvas edge).
describe('the canvas pane', () => {
  test('no conversation selected — no third pane', async () => {
    store = [item({ id: 'c1', waitingOn: 'human' })];
    await mount();
    expect(container.querySelector('.inbox-canvas')).toBeNull();
  });

  test('canvasId is null — the placeholder renders, not an iframe', async () => {
    store = [item({ id: 'c1', waitingOn: 'human', canvasId: null })];
    await mount();
    await click(items()[0] ?? null);

    expect(container.querySelector('.inbox-canvas-empty')).not.toBeNull();
    expect(container.querySelector('.inbox-canvas-empty')?.textContent).toContain('No canvas linked');
    expect(container.querySelector('.inbox-canvas iframe')).toBeNull();
  });

  test('canvasId is set — a live Render Pad iframe at the same URL the canvas stage uses', async () => {
    store = [item({ id: 'c1', workspaceId: 'ws_1', waitingOn: 'human', canvasId: 'cv_1' })];
    await mount();
    await click(items()[0] ?? null);

    const frame = container.querySelector('.inbox-canvas iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toBe('/w/ws_1/canvas/cv_1/pad');
    expect(frame?.getAttribute('title')).toBe('canvas');
    expect(container.querySelector('.inbox-canvas-empty') === null).toBe(true);
  });

  test('a toggle button hides the canvas pane (persisted; the thread takes the space)', async () => {
    store = [item({ id: 'c1', waitingOn: 'human', canvasId: 'cv_1' })];
    await mount();
    await click(items()[0] ?? null);
    expect(container.querySelector('.inbox-canvas')).not.toBeNull();

    await click(container.querySelector('[aria-label="Hide canvas"]'));
    expect(container.querySelector('.inbox-canvas')).toBeNull();

    await click(container.querySelector('[aria-label="Show canvas"]'));
    expect(container.querySelector('.inbox-canvas')).not.toBeNull();
  });
});

// The conversation list folds to a slim strip (full-width thread); sticky per device.
describe('the list collapses', () => {
  test('« hides the list, the state survives a remount, » brings it back', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    await click(container.querySelector('[title="Hide conversations (full thread)"]'));
    expect(container.querySelector('.inbox-items')).toBeNull();
    expect(container.querySelector('.inbox-list.collapsed')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    await mount();
    expect(container.querySelector('.inbox-list.collapsed')).not.toBeNull();

    await click(container.querySelector('[title="Show conversations"]'));
    expect(container.querySelector('.inbox-items')).not.toBeNull();
  });
});

// Starting a new chat from the Inbox (Concept 2): the entry point is a PRIMARY button that sits
// ABOVE the filter row (not wedged inside it), and the not-yet-saved chat is a PINNED row-zero in
// the list — "New chat · draft" — so it is visible and obviously unsaved until the first send
// births the Conversation row. Clicking it mints a client-side chatId and mounts a live
// <ChatView>; NO request is made at click time (the row is born by the first send, row-at-start).
describe('starting a new chat', () => {
  const newChatButton = () => container.querySelector('.inbox-new-chat');
  /** The draft's client-minted chatId, read off the same-origin transcript request <ChatView>
   *  makes on mount — an observable of the component, not a peek at its state. */
  const draftChatId = (): string | null => {
    let found: string | null = null;
    for (const c of calls) {
      const m = /^GET .*\/api\/chat\/(chat_[^/]+)\/transcript$/.exec(c);
      if (m && !c.includes('/bridge/')) found = m[1] as string;
    }
    return found;
  };

  test('the New chat button sits above the filter row, not inside it', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();

    const button = newChatButton();
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('New chat');
    // Above the filters: not a descendant of `.inbox-filters`, and earlier in the list pane.
    expect(container.querySelector('.inbox-filters .inbox-new-chat')).toBeNull();
    const pane = container.querySelector('.inbox-list');
    const filters = container.querySelector('.inbox-filters');
    expect(pane?.contains(button as Node)).toBe(true);
    expect((button as Node).compareDocumentPosition(filters as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('clicking it opens a draft thread — no Conversation is created, no runner woken', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    calls = [];

    await click(newChatButton());

    expect(container.querySelector('.inbox-threadhead')?.textContent).toContain('New chat');
    // Row-at-start: the Conversation is born by the FIRST SEND, never by the click. So the click
    // writes nothing (no POST) and wakes nothing (no `/inbox/:id/bridge` resolve).
    expect(calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
    expect(calls.filter((c) => c.includes('/bridge'))).toEqual([]);
  });

  test('the draft is a pinned, selected row at the top of the list', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    expect(items().length).toBe(1);

    await click(newChatButton());

    const rows = items();
    expect(rows.length).toBe(2);
    // Row zero, ahead of every real conversation, badged so it reads as not-yet-saved.
    expect(rows[0]?.querySelector('b')?.textContent).toContain('New chat');
    expect(rows[0]?.textContent).toContain('draft');
    expect(rows[0]?.className).toContain('sel');
    expect(rows[1]?.querySelector('b')?.textContent).toBe('Ship it');
  });

  test('opening a real conversation drops the draft row', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    await click(newChatButton());
    expect(items().length).toBe(2);

    await click(items()[1] ?? null);

    expect(items().length).toBe(1);
    expect(container.querySelector('.inbox-item.draft')).toBeNull();
  });

  test('a list refetch that has not borne the draft yet keeps the draft row', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    await click(newChatButton());

    // The first send has not landed (or failed) — the refetch returns the same rows as before.
    await changeSelect(viewFilter(), 'all');

    const rows = items();
    expect(rows.length).toBe(2);
    expect(rows[0]?.className).toContain('draft');
    expect(container.querySelector('.inbox-threadhead')?.textContent).toContain('New chat');
  });

  test('once the row is born (ownerRef matches) the draft is replaced by the real conversation', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    await click(newChatButton());
    const chatId = (container.querySelector('.inbox-threadhead') as HTMLElement | null) && draftChatId();
    expect(chatId).toBeTruthy();

    // The first send created the Conversation on the bridge; the next list load returns it.
    store.push(item({ id: 'c2', summary: 'Pricing page copy', ownerRef: chatId as string }));
    await changeSelect(viewFilter(), 'all');

    expect(container.querySelector('.inbox-item.draft')).toBeNull();
    expect(container.querySelector('.inbox-threadhead')?.textContent).toContain('Pricing page copy');
    const selected = container.querySelector('.inbox-item.sel');
    expect(selected?.querySelector('b')?.textContent).toBe('Pricing page copy');
  });

  test('the button renders (and still drafts) while the list is loading, when empty, and on error', async () => {
    // Empty: the button is present alongside the empty-list message.
    store = [];
    await mount();
    expect(newChatButton()).not.toBeNull();
    expect(container.querySelector('.inbox-empty')?.textContent).toContain('No conversations.');
    await click(newChatButton());
    expect(items().length).toBe(1);
    expect(items()[0]?.className).toContain('draft');

    // Error: the list fetch fails, but drafting is a client-side state change and still works.
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await mount();
    expect(container.querySelector('.inbox-empty')?.textContent).toContain('Failed to load.');
    expect(newChatButton()).not.toBeNull();
    await click(newChatButton());
    expect(container.querySelector('.inbox-threadhead')?.textContent).toContain('New chat');
  });

  test('the button is present before the list resolves (loading)', async () => {
    // A list request that never settles: the pane is in its loading state the whole time.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, 'https://poc.cedarpad.com').pathname === '/api/inbox') return new Promise(() => {}) as never;
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    await mount();

    expect(container.querySelector('.inbox-empty')?.textContent).toContain('Loading…');
    expect(newChatButton()).not.toBeNull();
    expect((newChatButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test('Cmd/Ctrl+N opens a draft from anywhere in the stage', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    expect(container.querySelector('.inbox-item.draft')).toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector('.inbox-item.draft')).not.toBeNull();
    expect(container.querySelector('.inbox-threadhead')?.textContent).toContain('New chat');
  });

  test('pressing New chat again reuses the open draft rather than stacking a second one', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' })];
    await mount();
    await click(newChatButton());
    const first = draftChatId();
    expect(first).toBeTruthy();

    await click(newChatButton());

    // One draft row, and the SAME chat — a second click must not discard a half-typed message.
    expect(container.querySelectorAll('.inbox-item.draft').length).toBe(1);
    expect(draftChatId()).toBe(first as string);
  });
});

// Choosing the chat KIND for a new chat (CEDA-N67Y50, approved design: the split "New chat"
// button). The primary button is unchanged — one click still starts an ordinary chat. A caret
// beside it opens a two-item menu; picking "Dev-agent" starts the draft as a dev-agent chat,
// which the draft's FIRST send declares to the edge on `x-chat-kind` (there is no Conversation
// row yet, so the edge's row-driven arming has nothing to key on — see worker/index.ts).
describe('choosing the chat kind for a new chat', () => {
  const newChatButton = () => container.querySelector('.inbox-new-chat');
  const caret = () => container.querySelector('.inbox-new-kind');
  const menuItems = () => [...container.querySelectorAll('.inbox-kind-menu button')];

  /** The draft's client-minted chatId, read off the same-origin transcript request its
   *  <ChatView> makes on mount — an observable of the component, not a peek at its state. */
  const draftChatId = (): string => {
    let found: string | null = null;
    for (const c of calls) {
      const m = /^GET .*\/api\/chat\/(chat_[^/]+)\/transcript$/.exec(c);
      if (m && !c.includes('/bridge/')) found = m[1] as string;
    }
    expect(found).not.toBeNull();
    return found as string;
  };

  /** Send the draft's first message — the send that BIRTHS the Conversation, and the one the
   *  declared kind rides on. Driven through `chat-store`'s exported `send`, the same entry
   *  point <ChatView>'s composer calls, so the assertion stays on the public interface. */
  const sendFirstMessage = async (text: string) => {
    await act(async () => {
      await send(draftChatId(), text, []);
    });
    await flush();
  };

  test('the caret opens a two-item menu naming both kinds', async () => {
    await mount();
    expect(menuItems()).toEqual([]);

    await click(caret());

    expect(menuItems().map((b) => b.textContent)).toEqual([
      expect.stringContaining('Chat'),
      expect.stringContaining('Dev-agent'),
    ]);
  });

  test('picking Dev-agent starts a draft whose first send declares the dev-agent kind', async () => {
    await mount();
    await click(caret());

    await click(menuItems()[1] ?? null);

    expect(container.querySelector('.inbox-item.draft')).not.toBeNull();
    await sendFirstMessage('open a PR for the sync seam');
    expect(sends.map((s) => s.kind)).toEqual(['dev-agent']);
  });

  test('the plain button still starts an ordinary chat — nothing declared', async () => {
    await mount();

    await click(newChatButton());
    await sendFirstMessage('what is a nostr relay');

    expect(sends.map((s) => s.kind)).toEqual([null]);
  });

  test('the draft row is badged with the kind it will be born as', async () => {
    await mount();
    await click(caret());
    await click(menuItems()[1] ?? null);

    expect(container.querySelector('.inbox-item.draft')?.textContent).toContain('dev-agent');
  });

  test('the picked kind sticks: the plain button starts the next chat as dev-agent too', async () => {
    await mount();
    await click(caret());
    await click(menuItems()[1] ?? null);
    await sendFirstMessage('first');
    await act(async () => root.unmount());
    await mount();

    await click(newChatButton());
    await sendFirstMessage('second');

    expect(sends.map((s) => s.kind)).toEqual(['dev-agent', 'dev-agent']);
  });
});

// The Inbox merge (CONTEXT.md "Open PR"). The run's PR takes the third pane — the slot the
// linked canvas otherwise holds — so the artifact you opened the row for gets the same
// first-class space, and a conversation that has both lets you switch between them.
describe('the PR pane: landing a dev-agent run without leaving the Inbox', () => {
  const PR = 'https://github.com/Zabaca/cedarpad/pull/283';
  const prPane = () => container.querySelector('.inbox-pr');
  const mergeBtn = () => container.querySelector('.inbox-pr-merge') as HTMLButtonElement | null;
  const paneToggle = () => [...container.querySelectorAll('.inbox-pane-switch button')];
  const openFirst = async () => {
    await mount();
    await flush();
    await click(items()[0] as Element);
  };

  test('a run with an open PR shows the PR pane, with the PR it opened', async () => {
    store = [item({ id: 'c1', kind: 'dev-agent', repo: 'Zabaca/cedarpad', prUrl: PR })];
    await openFirst();

    expect(prPane() !== null).toBe(true);
    expect(prPane()?.textContent).toContain('#283');
    expect(prPane()?.textContent).toContain('Zabaca/cedarpad');
    expect(mergeBtn() !== null).toBe(true);
    // The pane replaces the canvas — this conversation has no canvas to attach anyway.
    expect(container.querySelector('.inbox-canvas-empty') === null).toBe(true);
  });

  test('an ordinary chat has no PR pane and no merge action', async () => {
    store = [item({ id: 'c1', canvasId: 'cv_1' })];
    await openFirst();

    expect(prPane() === null).toBe(true);
    expect(mergeBtn() === null).toBe(true);
  });

  test('merging calls the edge merge route and the row lands merged + closed', async () => {
    store = [item({ id: 'c1', kind: 'dev-agent', repo: 'Zabaca/cedarpad', prUrl: PR })];
    await openFirst();

    await click(mergeBtn());

    expect(calls).toContain('POST /api/inbox/c1/merge');
    expect(store[0]?.prMergedAt).toBe(1234);
    expect(store[0]?.status).toBe('closed');
    // The pane becomes the receipt: no second merge is offered.
    expect(mergeBtn() === null).toBe(true);
    expect(prPane()?.textContent).toContain('Merged');
  });

  test('a refusal shows GitHub‘s own reason and leaves the PR mergeable', async () => {
    store = [item({ id: 'c1', kind: 'dev-agent', repo: 'Zabaca/cedarpad', prUrl: PR })];
    mergeFails = 'Pull Request is not mergeable';
    await openFirst();

    await click(mergeBtn());

    expect(prPane()?.textContent).toContain('Pull Request is not mergeable');
    expect(store[0]?.prMergedAt).toBeNull();
    // Retrying after CI goes green is one click — the button is still there.
    expect(mergeBtn() !== null).toBe(true);
  });

  test('with a canvas AND an open PR the pane leads with the PR and offers the switch', async () => {
    store = [item({ id: 'c1', kind: 'dev-agent', repo: 'Zabaca/cedarpad', prUrl: PR, canvasId: 'cv_1' })];
    await openFirst();

    expect(prPane() !== null).toBe(true);
    expect(paneToggle().map((b) => b.textContent)).toEqual(['PR', 'Canvas']);

    await click(paneToggle()[1] as Element);
    expect(prPane() === null).toBe(true);
    expect(container.querySelector('.inbox-canvas-frame') !== null).toBe(true);

    await click(paneToggle()[0] as Element);
    expect(prPane() !== null).toBe(true);
  });

  test('with no canvas there is nothing to switch between, so no switch is rendered', async () => {
    store = [item({ id: 'c1', kind: 'dev-agent', repo: 'Zabaca/cedarpad', prUrl: PR })];
    await openFirst();

    expect(paneToggle()).toEqual([]);
  });
});
