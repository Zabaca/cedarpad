// Registers happy-dom globals first: these tests exercise the DOM-coupled router
// (EventSource/fetch are stubbed per test). chat-store does NOT open an SSE stream here, so the
// missing EventSource global is irrelevant here.
import './happydom-harness.ts';

import { beforeEach, describe, expect, test } from 'bun:test';

import { type ChatEvent, isChatFrame } from '../shared/chat-wire.ts';
import type { ChatSnapshot } from './chat-store';
import { ensureSession, forkSession, getSnapshot, isSubscribed, openStream, routeChatFrame, send, subscribe } from './chat-store';

/** Serialize a wire frame the way the bridge does: a ChatEvent tagged with its chatId. */
const frame = (chatId: string, ev: ChatEvent): string => JSON.stringify({ chatId, ...ev });

// Fork is now SERVER-driven (ADR 0004): the child's ChatMeta is seeded server-side (it can
// resume the parent's session with a one-shot fork), then the child rehydrates from the
// JSONL-derived transcript. The client no longer copies transcript/sdk from localStorage.
describe('forkSession (server-driven)', () => {
  test('POSTs the fork to the child with {from: parent}, then rehydrates the child from the server', async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body });
      if (u.endsWith('/transcript'))
        return new Response(
          JSON.stringify({ config: { model: 'opus' }, events: [{ kind: 'delta', text: 'hi', role: 'user' }, { kind: 'delta', text: 'yo' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      forkSession('chat_parent_a', 'chat_child_a');

      // The /fork POST fires synchronously.
      const fork = calls.find((c) => c.url.endsWith('/api/chat/chat_child_a/fork'));
      expect(fork?.method).toBe('POST');
      expect(JSON.parse(fork!.body!)).toEqual({ from: 'chat_parent_a' });

      // Let the POST resolve → rehydrate GET /transcript → replay through applyEvent.
      await new Promise((r) => setTimeout(r, 0));
      const c = getSnapshot('chat_child_a');
      expect(c.model).toBe('opus'); // config applied
      expect(c.items.map((it) => (it.kind === 'msg' ? [it.role, it.text] : [it.kind]))).toEqual([
        ['user', 'hi'],
        ['agent', 'yo'],
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('routeChatFrame: the SSE chat routing seam', () => {
  beforeEach(() => localStorage.clear());

  test('drops a frame whose chatId is unknown to sessions: no listener fires, no snapshot mutates', () => {
    const known = 'chat_route_known';
    ensureSession(known);
    const before = getSnapshot(known);
    let fired = 0;
    const unsub = subscribe(known, () => { fired += 1; });

    routeChatFrame(frame('chat_route_unknown', { kind: 'delta', text: 'should not land' }));

    expect(fired).toBe(0); // no listener for any held chat fired
    expect(getSnapshot(known)).toBe(before); // snapshot reference unchanged = no mutation
    expect(getSnapshot('chat_route_unknown').items).toEqual([]); // the unknown chat got no session
    unsub();
  });

  test('a delta for chat A does not mutate chat B', () => {
    const a = 'chat_iso_a';
    const b = 'chat_iso_b';
    ensureSession(a);
    ensureSession(b);
    const beforeB = getSnapshot(b);

    routeChatFrame(frame(a, { kind: 'delta', text: 'hi A' }));

    const afterB = getSnapshot(b);
    expect(afterB).toBe(beforeB); // B's snapshot is untouched (same reference)
    expect(afterB.items).toEqual([]);
    expect(getSnapshot(a).items.at(-1)).toMatchObject({ kind: 'msg', role: 'agent', text: 'hi A' });
  });

  test('malformed JSON on the channel is ignored: no throw, no mutation', () => {
    const id = 'chat_malformed';
    ensureSession(id);
    const before = getSnapshot(id);

    expect(() => routeChatFrame('{ not valid json')).not.toThrow();

    expect(getSnapshot(id)).toBe(before);
  });

  test('a valid-JSON but non-frame message (missing kind) is ignored', () => {
    const id = 'chat_nonframe';
    ensureSession(id);
    const before = getSnapshot(id);

    routeChatFrame(JSON.stringify({ chatId: id, text: 'no kind here' }));

    expect(getSnapshot(id)).toBe(before);
  });

  // One frame per kind (all 8) round-trips through routeChatFrame -> applyEvent and
  // lands in the expected snapshot field. Table-driven so a new kind is a one-row add.
  const cases: Array<{ kind: string; ev: ChatEvent; check: (s: ChatSnapshot) => void }> = [
    {
      kind: 'delta',
      ev: { kind: 'delta', text: 'hello world' },
      check: (s) => expect(s.items.at(-1)).toMatchObject({ kind: 'msg', role: 'agent', text: 'hello world' }),
    },
    {
      kind: 'tool_start',
      ev: { kind: 'tool_start', name: 'Bash' },
      check: (s) => expect(s.status).toBe('running Bash'),
    },
    {
      kind: 'tool',
      ev: { kind: 'tool', name: 'Read', input: { file_path: '/a/b/file.ts' } },
      check: (s) => {
        expect(s.status).toBe('working');
        expect(s.items.at(-1)).toMatchObject({ kind: 'tool', label: 'Read · file.ts' });
      },
    },
    {
      kind: 'thinking',
      ev: { kind: 'thinking', thinkingTokens: 1234 },
      check: (s) => expect(s.status).toContain('thinking'),
    },
    {
      kind: 'tool_progress',
      ev: { kind: 'tool_progress', name: 'Bash', elapsed: 7 },
      check: (s) => expect(s.status).toBe('running Bash · 7s'),
    },
    {
      kind: 'task',
      ev: { kind: 'task', taskId: 't1', status: 'running', taskType: 'shell', title: 'a job' },
      check: (s) => expect(s.tasks['t1']).toMatchObject({ id: 't1', status: 'running', taskType: 'shell', title: 'a job' }),
    },
    {
      kind: 'todo',
      ev: { kind: 'todo', todoId: 'd1', subject: 'do the thing', todoStatus: 'pending' },
      check: (s) => expect(s.todos['d1']).toMatchObject({ id: 'd1', subject: 'do the thing', status: 'pending' }),
    },
    {
      kind: 'done',
      ev: { kind: 'done', sessionId: 'sess-xyz', costUsd: 0.42, contextPct: 33 },
      check: (s) => {
        expect(s.busy).toBe(false);
        expect(s.status).toBe('');
        expect(s.sdk).toBe('sess-xyz');
        expect(s.contextPct).toBe(33);
      },
    },
  ];

  for (const c of cases) {
    test(`kind '${c.kind}' routes to its snapshot field`, () => {
      const id = `chat_kind_${c.kind}`;
      ensureSession(id);
      routeChatFrame(frame(id, c.ev));
      c.check(getSnapshot(id));
    });
  }
});

describe('isChatFrame', () => {
  test('accepts a well-formed frame', () => {
    expect(isChatFrame({ chatId: 'c', kind: 'delta', text: 'x' })).toBe(true);
  });

  test('rejects a missing chatId', () => {
    expect(isChatFrame({ kind: 'delta', text: 'x' })).toBe(false);
  });

  test('rejects a non-string chatId', () => {
    expect(isChatFrame({ chatId: 5, kind: 'delta' })).toBe(false);
  });

  test('rejects a missing kind', () => {
    expect(isChatFrame({ chatId: 'c' })).toBe(false);
  });

  test('rejects non-object input', () => {
    expect(isChatFrame(null)).toBe(false);
    expect(isChatFrame(undefined)).toBe(false);
    expect(isChatFrame('a string')).toBe(false);
    expect(isChatFrame(42)).toBe(false);
  });
});

describe('isSubscribed: the client half of the subscribe-before-send contract', () => {
  test('false before the stream opens, true after the EventSource open event; send is suppressed until subscribed', async () => {
    // Stand in a fake EventSource (happy-dom provides none) that captures its
    // instance so the test can fire `onopen` deterministically, and a fetch spy so
    // we can prove a send only reaches the wire once subscribed.
    const realES = (globalThis as Record<string, unknown>).EventSource;
    const realFetch = globalThis.fetch;
    let esInstance: { onopen: (() => void) | null } | null = null;
    (globalThis as Record<string, unknown>).EventSource = class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(_url: string) {
        esInstance = this;
      }
      close() {}
    };
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      fetchCalls.push(String(url));
      return new Response('{"ok":true}', { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const id = 'chat_sub_gate';
      ensureSession(id);
      expect(isSubscribed(id)).toBe(false); // not connected yet

      // A send before the stream is open is suppressed client-side: no /send call,
      // and nothing is even appended to the transcript.
      await send(id, 'before subscribe', []);
      expect(fetchCalls).toEqual([]);
      expect(getSnapshot(id).items).toEqual([]);

      openStream(id); // constructs the (fake) shared EventSource
      expect(esInstance).not.toBeNull();
      esInstance!.onopen!(); // fire the open event the store wired up
      expect(isSubscribed(id)).toBe(true);

      // Now a send goes through to the wire.
      await send(id, 'after subscribe', []);
      expect(fetchCalls.some((u) => u.includes(`/api/chat/${id}/send`))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as Record<string, unknown>).EventSource = realES;
    }
  });

  test('a 425 (or any non-2xx) from /send clears busy and surfaces an error, instead of hanging on busy forever', async () => {
    const realES = (globalThis as Record<string, unknown>).EventSource;
    const realFetch = globalThis.fetch;
    let esInstance: { onopen: (() => void) | null } | null = null;
    (globalThis as Record<string, unknown>).EventSource = class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(_url: string) {
        esInstance = this;
      }
      close() {}
    };
    // The server rejects an unsubscribed send with 425; fetch RESOLVES (does not throw) on it.
    globalThis.fetch = (async () => new Response('{"error":"no_subscribers"}', { status: 425 })) as unknown as typeof fetch;

    try {
      const id = 'chat_send_425';
      ensureSession(id);
      openStream(id);
      // Subscribe so send() isn't gated client-side. If openStream built a fresh stream
      // (this test ran first) it's not subscribed yet, so fire its onopen; if an earlier
      // test left the shared stream open, openStream already subscribed and we skip.
      if (!isSubscribed(id)) esInstance!.onopen!();
      expect(isSubscribed(id)).toBe(true);

      await send(id, 'will be rejected', []);
      await new Promise((r) => setTimeout(r, 0)); // let dispatchSend's fetch + state update settle

      const s = getSnapshot(id);
      expect(s.busy).toBe(false); // NOT stuck on busy
      expect(s.status).toBe('');
      expect(s.items.at(-1)).toMatchObject({ kind: 'msg', role: 'agent', text: '⚠ chat connection not ready, resend in a moment' });
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as Record<string, unknown>).EventSource = realES;
    }
  });
});
