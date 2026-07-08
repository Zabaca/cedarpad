// happy-dom's window/document must register BEFORE the component tree imports (shared with
// the canvas + Shell tests — it preserves Bun's native fetch/Response, which we stub here).
import '../../../src/happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ChatEvent } from '../../../shared/chat-wire';
import { InboxStage } from './Inbox';

// A minimal in-memory edge Inbox: a mutable list of items + per-id transcripts, served the
// same way the real `/api/inbox*` endpoints shape their JSON. The list filters by the
// `status`/`workspace` query params (like conversations.list), so a close really does drop a
// row from the open view. Every request is recorded so we can assert what the UI called —
// and, crucially, that it ONLY ever talks to `/api/inbox*` (browsing never wakes anything).

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
let transcripts: Record<string, ChatEvent[]> = {};

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

function stubInbox() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const u = new URL(url, 'https://poc.cedarpad.com');

    // GET /api/inbox?status=&workspace=
    if (u.pathname === '/api/inbox' && method === 'GET') {
      const status = u.searchParams.get('status');
      const workspace = u.searchParams.get('workspace');
      const items = store.filter(
        (it) => (!status || it.status === status) && (!workspace || it.workspaceId === workspace),
      );
      return Response.json({ items });
    }

    const m = /^\/api\/inbox\/([^/]+)(?:\/(reply|close|reopen))?$/.exec(u.pathname);
    if (m) {
      const id = m[1] as string;
      const action = m[2];
      const row = store.find((it) => it.id === id);
      if (action === 'close' || action === 'reopen') {
        if (row) row.status = action === 'close' ? 'closed' : 'open';
        return Response.json({ conversation: row });
      }
      if (action === 'reply') return Response.json({ ok: true });
      // detail
      return Response.json({
        conversation: { sessionId: `sess_${id}`, status: row?.status ?? 'open', summary: row?.summary ?? null },
        events: transcripts[id] ?? [],
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

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
    await Promise.resolve();
  });
};

const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
};

/** Set a <select>'s value and fire the change React listens for. */
const changeSelect = async (el: Element | null, value: string) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLSelectElement).value = value;
    (el as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};

// The reply box is uncontrolled (read from the DOM on send), so a plain value assignment is
// all it takes — no React change event to coax through happy-dom's value tracker.
const typeInto = (el: Element | null, value: string) => {
  expect(el).not.toBeNull();
  (el as HTMLTextAreaElement).value = value;
};

const items = () => [...container.querySelectorAll('.inbox-item')];
const statusFilter = () => container.querySelector('[aria-label="Status filter"]');

beforeEach(() => {
  calls = [];
  store = [];
  transcripts = {};
  stubInbox();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  globalThis.fetch = realFetch;
});

// The list is the ported left pane: it renders the edge list and re-queries on filter change.
describe('the inbox list', () => {
  test('lists the items from GET /api/inbox, defaulting to the open filter', async () => {
    store = [item({ id: 'c1', summary: 'Ship it' }), item({ id: 'c2', summary: 'Review PR' })];
    await mount();

    expect(calls).toContain('GET /api/inbox?status=open');
    expect(items().map((el) => el.querySelector('b')?.textContent)).toEqual(['Ship it', 'Review PR']);
  });

  test('changing the status filter re-queries with the new ?status=', async () => {
    store = [item({ id: 'c1', status: 'open' })];
    await mount();
    calls = [];

    await changeSelect(statusFilter(), 'closed');
    expect(calls).toContain('GET /api/inbox?status=closed');

    await changeSelect(statusFilter(), '');
    expect(calls).toContain('GET /api/inbox'); // "All" ⇒ no status param
  });

  test('the whole stage only ever talks to /api/inbox* — browsing never wakes a container', async () => {
    store = [item({ id: 'c1' })];
    await mount();
    await click(items()[0] ?? null); // open the conversation too

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
    store = [item({ id: 'c1', unread: true })];
    await mount();
    expect(container.querySelector('.inbox-dot')).not.toBeNull();
  });

  test('a closed item (not waiting) renders the closed badge', async () => {
    store = [item({ id: 'c1', status: 'closed', waitingOn: 'none' })];
    await mount();
    // The closed filter surfaces it.
    await changeSelect(statusFilter(), 'closed');
    const badge = container.querySelector('.inbox-badge');
    expect(badge?.textContent).toBe('closed');
    expect(badge?.className).toContain('closed');
  });
});

// The right pane: the transcript rendered from the R2-backed detail (no container woken).
describe('opening a conversation', () => {
  test('renders delta / tool / thinking events distinctly', async () => {
    store = [item({ id: 'c1', summary: 'Thread' })];
    transcripts.c1 = [
      { kind: 'delta', text: 'hello from the human', role: 'user' },
      { kind: 'delta', text: 'hi from the agent' },
      { kind: 'tool', name: 'Bash', input: {} },
      { kind: 'thinking', thinkingTokens: 12 },
    ];
    await mount();
    await click(items()[0] ?? null);

    expect(calls).toContain('GET /api/inbox/c1');

    const evs = [...container.querySelectorAll('.inbox-ev')];
    // A user delta and an assistant delta, each a bubble.
    const userEv = evs.find((e) => e.className.includes('user'));
    const asstEv = evs.find((e) => e.className.includes('assistant'));
    expect(userEv?.querySelector('.inbox-bubble')?.textContent).toBe('hello from the human');
    expect(asstEv?.querySelector('.inbox-bubble')?.textContent).toBe('hi from the agent');
    // Tool + thinking are meta lines with no bubble.
    const metas = evs.filter((e) => e.className.includes('meta')).map((e) => e.textContent);
    expect(metas).toContain('→ Bash');
    expect(metas).toContain('thinking…');
  });
});

// Close/reopen + reply hit the exact edge routes and refresh the list.
describe('thread actions', () => {
  test('Close posts /api/inbox/:id/close and the row leaves the open view', async () => {
    store = [item({ id: 'c1', summary: 'Close me', status: 'open' })];
    await mount();
    await click(items()[0] ?? null);

    await click(container.querySelector('.inbox-threadhead button'));

    expect(calls).toContain('POST /api/inbox/c1/close');
    // The default filter is still `open`; c1 is now closed, so it's gone from the list.
    expect(items()).toHaveLength(0);
  });

  test('Reply posts the message to /api/inbox/:id/reply and clears the box', async () => {
    store = [item({ id: 'c1', summary: 'Reply thread' })];
    await mount();
    await click(items()[0] ?? null);

    const box = container.querySelector('[aria-label="Reply"]');
    typeInto(box, 'on it');
    await click(container.querySelector('.inbox-reply button'));

    expect(calls).toContain('POST /api/inbox/c1/reply');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });
});
