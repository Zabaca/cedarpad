// happy-dom's window/document must register BEFORE the component tree imports (shared with
// the canvas + Shell tests — it preserves Bun's native fetch/Response, which we stub here).
import '../../../src/happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { connectionTarget } from '../../../shared/chat-store';
import { InboxStage } from './Inbox';

// A minimal in-memory edge for the Inbox stage. The LIST is Turso-only (`/api/inbox*`) and must
// never wake a runner. OPENING a Conversation is now a live <ChatView> over the owning bridge via
// the edge proxy (ADR-0009 / #124): the Shell first resolves the chatId from
// `GET /inbox/:id/bridge/api/inbox/:id/chat` (the ONLY wake), sets the chat-store connection
// target to that proxy prefix, and mounts <ChatView> — which then talks to the bridge under the
// prefix (transcript/stream/send). Every request is recorded so we can assert (a) that browsing
// the list touches ONLY `/api/inbox*` (no `/bridge` wake) and (b) that opening points <ChatView>
// at the proxy.

type Item = {
  id: string;
  status: 'open' | 'closed';
  waitingOn: 'human' | 'agent' | 'none';
  unread: boolean;
  summary: string | null;
  lastMessagePreview: string | null;
  workspaceId: string;
  lastActivity: number;
};

const realFetch = globalThis.fetch;
let calls: string[] = [];
let store: Item[] = [];

const item = (o: Partial<Item> & { id: string }): Item => ({
  status: 'open',
  waitingOn: 'none',
  unread: false,
  summary: o.id,
  lastMessagePreview: null,
  workspaceId: 'ws_1',
  lastActivity: 0,
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

    // GET /api/inbox?view=&workspace=  — the edge list (Turso, no wake). view maps to the same
    // (status, waiting_on) filter the edge's viewToListOpts applies.
    if (u.pathname === '/api/inbox' && method === 'GET') {
      const view = u.searchParams.get('view') ?? 'needs-me';
      const workspace = u.searchParams.get('workspace');
      const items = store.filter((it) => {
        const matchesView =
          view === 'closed'
            ? it.status === 'closed'
            : view === 'open'
              ? it.status === 'open'
              : view === 'all'
                ? true
                : it.status === 'open' && it.waitingOn === 'human'; // needs-me (default)
        return matchesView && (!workspace || it.workspaceId === workspace);
      });
      return Response.json({ items });
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
    root.render(<InboxStage />);
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
  store = [];
  stubInbox();
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown;
  // Give the document a real origin so pushState (relative URL) resolves under happy-dom, whose
  // default document is about:blank (origin null) — same fix as Shell.test.tsx.
  (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL('https://poc.cedarpad.com/');
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

// The list is the ported left pane: it renders the edge list and re-queries on filter change.
describe('the inbox list', () => {
  test('defaults to the "Needs me" view — GET /api/inbox?view=needs-me, showing waiting_on:human items', async () => {
    store = [
      item({ id: 'c1', summary: 'Ship it', waitingOn: 'human' }),
      item({ id: 'c2', summary: 'Review PR', waitingOn: 'human' }),
      item({ id: 'c3', summary: 'idle chat', waitingOn: 'none' }), // a plain session — hidden by default
    ];
    await mount();

    expect(calls).toContain('GET /api/inbox?view=needs-me');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['Ship it', 'Review PR']);
  });

  test('"Open" shows every open session — including non-promoted ones the default hides', async () => {
    store = [item({ id: 'c1', summary: 'ask', waitingOn: 'human' }), item({ id: 'c2', summary: 'idle chat', waitingOn: 'none' })];
    await mount();
    calls = [];

    await changeSelect(viewFilter(), 'open');
    expect(calls).toContain('GET /api/inbox?view=open');
    // the idle (waiting_on:none) session now appears — every open session
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['ask', 'idle chat']);

    await changeSelect(viewFilter(), 'closed');
    expect(calls).toContain('GET /api/inbox?view=closed');
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

  test('browsing the list never wakes a runner — it touches ONLY /api/inbox*', async () => {
    store = [item({ id: 'c1', waitingOn: 'human' }), item({ id: 'c2', waitingOn: 'human' })];
    await mount();
    await changeSelect(viewFilter(), 'all'); // filter around

    // No /inbox/:id/bridge/* call (that is the only wake path); the list is Turso-only.
    expect(calls.some((c) => c.includes('/bridge'))).toBe(false);
    expect(calls.every((c) => c.includes('/api/inbox'))).toBe(true);
  });
});

// The row decorations ported verbatim from INBOX_HTML's render().
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

    await click(container.querySelector('.inbox-threadhead button'));

    expect(calls).toContain('POST /api/inbox/c1/close');
    // The default "Needs me" view requires status:open; c1 is now closed, so it's gone from the list.
    expect(items()).toHaveLength(0);
  });
});

// Filters + selection are URL-persisted (mirrors stage.ts): a reload lands back on the same
// view/workspace/selected conversation.
describe('URL-persisted state', () => {
  test('mounting with ?view=all&conv=<id> restores the filter and selects that conversation once the list loads', async () => {
    store = [
      item({ id: 'c1', summary: 'idle chat', waitingOn: 'none' }), // needs-me would hide this
    ];
    window.history.pushState(null, '', '/?stage=inbox&view=all&conv=c1');
    await mount();

    expect(calls).toContain('GET /api/inbox?view=all');
    expect((viewFilter() as HTMLSelectElement).value).toBe('all');
    // Selected once the async list loaded and contained it — the thread pane mounts <ChatView>.
    expect(container.querySelector('.chat-card')).not.toBeNull();
    expect(container.querySelector('.inbox-item.sel')?.querySelector('b')?.textContent).toBe('idle chat');
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
    expect(params.has('view')).toBe(false); // needs-me is the default — kept out of the URL
  });
});
