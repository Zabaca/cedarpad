// Registers happy-dom globals first: these tests exercise the DOM-coupled router
// (EventSource/fetch are stubbed per test). chat-store does NOT open an SSE stream here, so the
// missing EventSource global is irrelevant here.
import './happydom-harness.ts';

import { beforeEach, describe, expect, test } from 'bun:test';

import { type ChatEvent, isChatFrame } from '../shared/chat-wire.ts';
import type { ChatSnapshot } from '../shared/chat-store';
import { __closeSharedStreamForTests, armFirstPrompt, beatTargets, connectionTarget, ensureSession, forkSession, getSnapshot, interrupt, isSubscribed, openStream, routeChatFrame, send, setCanvasOverride, setConnectionTarget, subscribe, takeFirstPrompt, toolDetail, toolNameOf, toolParts } from '../shared/chat-store';
import { aliveUrl } from './idle.ts';

/** Serialize a wire frame the way the bridge does: a ChatEvent tagged with its chatId. */
const frame = (chatId: string, ev: ChatEvent): string => JSON.stringify({ chatId, ...ev });

// ADR-0011: the `init` frame marks a turn's start. A tab that DIDN'T start the turn (a
// headless dev-agent run, another tab's send) learns the chat is busy from it — so its own
// send() queues instead of firing a concurrent turn — and captures the session id early.
describe('init frame (a turn started, possibly not by this tab)', () => {
  test('foreign init on a held chat → busy:true + sdk captured, so a send queues instead of firing', () => {
    ensureSession('chat_foreign_run'); // frames only apply to chats this client holds
    routeChatFrame(frame('chat_foreign_run', { kind: 'init', sessionId: 'sess_run_1' }));

    const s = getSnapshot('chat_foreign_run');
    expect(s.busy).toBe(true); // send() will queue while the foreign turn runs
    expect(s.sdk).toBe('sess_run_1');
  });

  test('done clears the init-driven busy (normal turn settle)', () => {
    ensureSession('chat_foreign_run2');
    routeChatFrame(frame('chat_foreign_run2', { kind: 'init', sessionId: 'sess_run_2' }));
    expect(getSnapshot('chat_foreign_run2').busy).toBe(true);
    routeChatFrame(frame('chat_foreign_run2', { kind: 'done', sessionId: 'sess_run_2', costUsd: 0 }));

    expect(getSnapshot('chat_foreign_run2').busy).toBe(false);
  });
});

// `toolLabel` gets one line, so it truncates (Bash at 44 chars, paths to their basename).
// That used to be the ONLY record of a call — a long curl read as `curl -s "https://query1…`
// and you could not tell what ran. `toolDetail` keeps the untruncated text for the
// disclosure under the label.
describe('toolDetail: the full text behind a truncated tool label', () => {
  const long = 'curl -s "https://query1.finance.yahoo.com/v8/finance/chart/VT?range=max&interval=1mo"';

  test('a truncated Bash command is recoverable in full', () => {
    const detail = toolDetail({ kind: 'tool', name: 'Bash', input: { command: long } });
    expect(detail).toBe(long);
    expect(detail).not.toContain('…');
  });

  test('a non-Bash input is shown as its parameter bag', () => {
    const detail = toolDetail({ kind: 'tool', name: 'Read', input: { file_path: '/repo/app/settings/page.tsx' } });
    expect(detail).toContain('"file_path"');
    expect(detail).toContain('/repo/app/settings/page.tsx'); // the label only kept `page.tsx`
  });

  test('nothing to add ⇒ no disclosure', () => {
    expect(toolDetail({ kind: 'tool', name: 'end_turn', input: null })).toBeUndefined();
    // `Bash · ls` already shows the whole command; an expander revealing the same string is
    // worse than none, so a short command gets no chevron.
    expect(toolDetail({ kind: 'tool', name: 'Bash', input: { command: 'ls' } })).toBeUndefined();
  });

  test('a huge input is capped, and says so rather than silently ending', () => {
    const detail = toolDetail({ kind: 'tool', name: 'Write', input: { content: 'x'.repeat(20_000) } });
    expect(detail?.length).toBeLessThan(4_200);
    expect(detail).toContain('truncated');
  });

  test('a cyclic input does not throw a render away', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolDetail({ kind: 'tool', name: 'Weird', input: cyclic })).toBeUndefined();
  });

  test('a tool frame carries the detail onto its transcript item', () => {
    const chatId = 'shape:detail1';
    ensureSession(chatId);
    routeChatFrame(frame(chatId, { kind: 'tool', name: 'Bash', input: { command: long } }));
    const item = getSnapshot(chatId).items.at(-1);
    expect(item).toMatchObject({ kind: 'tool', detail: long });
  });
});

// A tool line says two things — WHICH tool, and WHAT it acted on — and they carry different
// weight. Flattened into one string they render at one emphasis, so `combined.json` is as
// quiet as the `Read` in front of it. The view renders the halves separately; these pin the
// split so it cannot drift from the flat label the store also keeps.
describe('toolParts / toolNameOf: the two halves of a tool line', () => {
  test('a file tool splits into its name and the file it touched', () => {
    expect(toolParts({ kind: 'tool', name: 'Read', input: { file_path: '/repo/data/combined.json' } })).toEqual({
      name: 'Read',
      arg: 'combined.json',
    });
    expect(toolNameOf('Read · combined.json', 'combined.json')).toBe('Read');
  });

  test('a count hangs off the name without the separator, and still splits cleanly', () => {
    expect(toolNameOf('create_shapes ×3', '×3')).toBe('create_shapes');
  });

  test('no arg — or a label that is not name+arg, like a subagent chip — stays whole', () => {
    expect(toolNameOf('end_turn', undefined)).toBe('end_turn');
    expect(toolNameOf('⤷ code-reviewer · completed', 'nope')).toBe('⤷ code-reviewer · completed');
  });

  test('a tool frame carries the arg onto its item, so the view can emphasise it', () => {
    const chatId = 'shape:arg1';
    ensureSession(chatId);
    routeChatFrame(frame(chatId, { kind: 'tool', name: 'Read', input: { file_path: '/repo/data/combined.json' } }));
    expect(getSnapshot(chatId).items.at(-1)).toMatchObject({ label: 'Read · combined.json', arg: 'combined.json' });
  });
});

// end_turn (and legacy ask_human in old transcripts) is the one tool whose INPUT is human-facing:
// the question/summary it posts to the Inbox. The thread must RENDER it — a chip with the text
// discarded left the human unable to read what they were being asked (both live and on rehydrate,
// since replay emits the same tool event).
describe('end_turn tool event → the question/summary renders as a readable bubble', () => {
  test('needs_human: the tool chip is followed by the question text as an agent message', () => {
    const id = 'chat_endturn_q';
    ensureSession(id);
    routeChatFrame(
      frame(id, {
        kind: 'tool',
        name: 'end_turn',
        input: { outcome: 'needs_human', summary: '6 candidates to review', question: '1. [high] Consolidate X\n2. [low] Simplify Y' },
      }),
    );

    const items = getSnapshot(id).items;
    expect(items.at(-2)).toMatchObject({ kind: 'tool', label: 'end_turn' });
    expect(items.at(-1)).toMatchObject({ kind: 'msg', role: 'agent', text: '1. [high] Consolidate X\n2. [low] Simplify Y' });
  });

  test('done: the tool chip is followed by the summary as an agent message', () => {
    const id = 'chat_endturn_done';
    ensureSession(id);
    routeChatFrame(frame(id, { kind: 'tool', name: 'end_turn', input: { outcome: 'done', summary: 'Committed #3; plan for #2 ready' } }));

    const items = getSnapshot(id).items;
    expect(items.at(-2)).toMatchObject({ kind: 'tool', label: 'end_turn' });
    expect(items.at(-1)).toMatchObject({ kind: 'msg', role: 'agent', text: 'Committed #3; plan for #2 ready' });
  });

  test('legacy ask_human events (old transcripts) still render their question', () => {
    const id = 'chat_askhuman';
    ensureSession(id);
    routeChatFrame(
      frame(id, {
        kind: 'tool',
        name: 'ask_human',
        input: { summary: '6 candidates to review', question: '1. [high] Consolidate X\n2. [low] Simplify Y' },
      }),
    );

    const items = getSnapshot(id).items;
    expect(items.at(-2)).toMatchObject({ kind: 'tool', label: 'ask_human' });
    expect(items.at(-1)).toMatchObject({ kind: 'msg', role: 'agent', text: '1. [high] Consolidate X\n2. [low] Simplify Y' });
  });

  test('other tools do NOT dump their input as a bubble', () => {
    const id = 'chat_othertool';
    ensureSession(id);
    routeChatFrame(frame(id, { kind: 'tool', name: 'Read', input: { file_path: '/a/b.ts' } }));

    expect(getSnapshot(id).items.at(-1)).toMatchObject({ kind: 'tool' });
  });
});

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
  // The shared SSE stream is module state and outlives a test FILE. Whichever
  // file runs first and opens it leaves `sharedStream` set, and `openStream`
  // below then attaches to that one instead of constructing this test's fake —
  // so `esInstance` stays null and this fails for a reason that has nothing to
  // do with the contract it is checking. Passes alone, fails in the suite.
  beforeEach(() => __closeSharedStreamForTests());

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

describe('connection target: per-chatId bridge prefix (ADR-0009 slice #121)', () => {
  // A tiny fake EventSource so openStream can construct the shared stream without a real
  // network. Captures constructed URLs + lets a test fire `onopen`.
  function withStubs(run: (ctx: { fetchCalls: string[]; esUrls: string[]; fireOpen: () => void }) => Promise<void> | void) {
    return async () => {
      const realES = (globalThis as Record<string, unknown>).EventSource;
      const realFetch = globalThis.fetch;
      const esUrls: string[] = [];
      let inst: { onopen: (() => void) | null } | null = null;
      (globalThis as Record<string, unknown>).EventSource = class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((e: { data: string }) => void) | null = null;
        constructor(url: string) {
          esUrls.push(url);
          inst = this;
        }
        close() {}
      };
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        fetchCalls.push(String(url));
        return new Response('{"ok":true}', { status: 202, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      try {
        await run({ fetchCalls, esUrls, fireOpen: () => inst?.onopen?.() });
      } finally {
        globalThis.fetch = realFetch;
        (globalThis as Record<string, unknown>).EventSource = realES;
      }
    };
  }

  test('connectionTarget defaults to same-origin (empty prefix) for an unset chat', () => {
    expect(connectionTarget('chat_ct_unset')).toBe('');
  });

  test('setConnectionTarget records the prefix per chatId', () => {
    setConnectionTarget('chat_ct_set', '/inbox/conv9/bridge');
    expect(connectionTarget('chat_ct_set')).toBe('/inbox/conv9/bridge');
    expect(connectionTarget('chat_ct_other')).toBe(''); // isolation: unset chats stay same-origin
  });

  test(
    'send builds /send under the chat\'s prefix; a same-origin chat is unaffected (per-chatId isolation)',
    withStubs(async ({ fetchCalls, fireOpen }) => {
      const proxied = 'chat_ct_proxied';
      const local = 'chat_ct_local';
      setConnectionTarget(proxied, '/inbox/conv1/bridge');
      openStream(proxied);
      if (!isSubscribed(proxied)) fireOpen();
      openStream(local);
      if (!isSubscribed(local)) fireOpen();

      await send(proxied, 'hi bridge', []);
      await send(local, 'hi origin', []);

      expect(fetchCalls).toContain('/inbox/conv1/bridge/api/chat/chat_ct_proxied/send');
      expect(fetchCalls).toContain('/api/chat/chat_ct_local/send');
      // The proxied chat must NOT leak the same-origin path (this fails if the prefix is ignored).
      expect(fetchCalls).not.toContain('/api/chat/chat_ct_proxied/send');
    }),
  );

  test(
    'interrupt builds /interrupt under the chat\'s prefix',
    withStubs(async ({ fetchCalls, fireOpen }) => {
      const id = 'chat_ct_interrupt';
      setConnectionTarget(id, '/inbox/conv2/bridge');
      openStream(id);
      if (!isSubscribed(id)) fireOpen();
      // interrupt is a no-op unless a turn is in flight; put the chat in busy state via a send.
      await send(id, 'start a turn', []);
      await interrupt(id);
      expect(fetchCalls).toContain('/inbox/conv2/bridge/api/chat/chat_ct_interrupt/interrupt');
      expect(fetchCalls).not.toContain('/api/chat/chat_ct_interrupt/interrupt');
    }),
  );

  test(
    'openStream rehydrates the transcript under the chat\'s prefix',
    withStubs(async ({ fetchCalls }) => {
      const id = 'chat_ct_open';
      setConnectionTarget(id, '/inbox/conv3/bridge');
      openStream(id);
      await new Promise((r) => setTimeout(r, 0)); // let rehydrate's fetch settle
      expect(fetchCalls).toContain('/inbox/conv3/bridge/api/chat/chat_ct_open/transcript');
      expect(fetchCalls).not.toContain('/api/chat/chat_ct_open/transcript');
    }),
  );

  test('beatTargets reports the distinct set of bridges holding live sessions', () => {
    // Fresh ids so the set is predictable regardless of what other tests left in `sessions`.
    const a = 'chat_beat_a';
    const b = 'chat_beat_b';
    const c = 'chat_beat_c';
    ensureSession(a); // same-origin
    setConnectionTarget(b, '/inbox/convX/bridge');
    ensureSession(b);
    setConnectionTarget(c, '/inbox/convX/bridge'); // same bridge as b — must dedupe
    ensureSession(c);
    const set = new Set(beatTargets());
    expect(set.has('')).toBe(true); // the same-origin session
    expect(set.has('/inbox/convX/bridge')).toBe(true); // the proxied bridge
    // b and c share one bridge — it appears once, not twice.
    expect(beatTargets().filter((t) => t === '/inbox/convX/bridge')).toHaveLength(1);
  });
});

// Docked chat panel: the Shell renders a canvas chat OUTSIDE the pad URL, so the
// location-based x-canvas-id stamp (withPadCanvasHeader) can't see its canvas. An explicit
// per-chat override keeps that chat's sends routed to — and claiming — the canvas the
// panel fronts, without ever stamping chats that have no canvas (Inbox threads).
describe('canvas override: a Shell-docked canvas chat stamps x-canvas-id explicitly', () => {
  function withHeaderSpy(run: (ctx: { headersFor: (path: string) => Record<string, string> | undefined; fireOpen: () => void }) => Promise<void>) {
    return async () => {
      const realES = (globalThis as Record<string, unknown>).EventSource;
      const realFetch = globalThis.fetch;
      let inst: { onopen: (() => void) | null } | null = null;
      (globalThis as Record<string, unknown>).EventSource = class {
        onopen: (() => void) | null = null;
        onerror: unknown = null;
        onmessage: unknown = null;
        constructor(_url: string) {
          inst = this;
        }
        close() {}
      };
      const seen = new Map<string, Record<string, string>>();
      globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
        seen.set(String(url), init?.headers ?? {});
        return new Response('{"ok":true}', { status: 202, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      try {
        await run({ headersFor: (path) => [...seen.entries()].find(([u]) => u.includes(path))?.[1], fireOpen: () => inst?.onopen?.() });
      } finally {
        globalThis.fetch = realFetch;
        (globalThis as Record<string, unknown>).EventSource = realES;
      }
    };
  }

  test(
    'send carries the overridden canvas id; an un-overridden chat carries none (per-chat isolation)',
    withHeaderSpy(async ({ headersFor, fireOpen }) => {
      const docked = 'chat_ov_docked';
      const plain = 'chat_ov_plain';
      setCanvasOverride(docked, 'cv_roadmap');
      openStream(docked);
      if (!isSubscribed(docked)) fireOpen();
      openStream(plain);
      if (!isSubscribed(plain)) fireOpen();

      await send(docked, 'hi from the panel', []);
      await send(plain, 'hi with no canvas', []);

      expect(headersFor(`/api/chat/${docked}/send`)?.['x-canvas-id']).toBe('cv_roadmap');
      // The claim is explicit, never a fallback: the plain chat must not be stamped at all.
      expect(headersFor(`/api/chat/${plain}/send`)?.['x-canvas-id']).toBeUndefined();
    }),
  );

  test(
    'the transcript rehydrate carries the override too (the docked chat reads its canvas session)',
    withHeaderSpy(async ({ headersFor }) => {
      const id = 'chat_ov_rehydrate';
      setCanvasOverride(id, 'cv_roadmap');
      openStream(id);
      await new Promise((r) => setTimeout(r, 0)); // let rehydrate's fetch settle
      expect(headersFor(`/api/chat/${id}/transcript`)?.['x-canvas-id']).toBe('cv_roadmap');
    }),
  );
});

describe('aliveUrl: the heartbeat URL under a connection-target prefix (slice #121)', () => {
  test('same-origin (empty prefix) is byte-identical to today: /api/alive', () => {
    expect(aliveUrl('')).toBe('/api/alive');
  });

  test('a proxy prefix routes the beat to that bridge', () => {
    expect(aliveUrl('/inbox/conv1/bridge')).toBe('/inbox/conv1/bridge/api/alive');
  });
});

// ADR-0011: the wire's 409 turn_in_flight means "a turn is running — wait". The client
// re-queues the send (it drains on the turn's done frame) instead of erroring, and a
// mid-run opener learns busy from the transcript rehydrate (it missed the init frame).
describe('409 turn_in_flight → re-queue; rehydrate carries busy', () => {
  // Shared harness: a fake EventSource (so openStream can subscribe) + a fetch stub whose
  // /send answers 409 until released; everything else answers a transcript body.
  const harness = (id: string, transcript: Record<string, unknown> = { config: {}, events: [] }) => {
    const realFetch = globalThis.fetch;
    const realES = (globalThis as Record<string, unknown>).EventSource;
    let esInstance: { onopen: (() => void) | null } | null = null;
    (globalThis as Record<string, unknown>).EventSource = class {
      onopen: (() => void) | null = null;
      onerror: unknown = null;
      onmessage: unknown = null;
      constructor(_url: string) {
        esInstance = this;
      }
      close() {}
    };
    const sends: string[] = [];
    const state = { reject409: true };
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).includes('/send')) {
        sends.push(JSON.parse(init!.body!).message);
        return state.reject409
          ? new Response('{"error":"turn_in_flight"}', { status: 409 })
          : new Response('{"ok":true}', { status: 202 });
      }
      return new Response(JSON.stringify(transcript), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    openStream(id);
    if (!isSubscribed(id)) esInstance!.onopen!();
    return {
      sends,
      state,
      restore() {
        globalThis.fetch = realFetch;
        (globalThis as Record<string, unknown>).EventSource = realES;
      },
    };
  };

  test('a send while busy (foreign init seen) queues locally and fires on done', async () => {
    const id = 'chat_409_requeue';
    const h = harness(id);
    try {
      await new Promise((r) => setTimeout(r, 0)); // let openStream's rehydrate settle
      routeChatFrame(frame(id, { kind: 'init', sessionId: 'sess_409' })); // a foreign turn is running

      await send(id, 'my steer', []);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.sends).toEqual([]); // queued locally — never hit the wire

      h.state.reject409 = false;
      routeChatFrame(frame(id, { kind: 'done', sessionId: 'sess_409', costUsd: 0 }));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.sends).toEqual(['my steer']); // drained on settle
    } finally {
      h.restore();
    }
  });

  test('a send that RACES the guard (no local busy, wire says 409) is re-queued, not errored', async () => {
    const id = 'chat_409_race';
    const h = harness(id);
    try {
      await new Promise((r) => setTimeout(r, 0));

      await send(id, 'raced send', []); // fires — server answers 409
      await new Promise((r) => setTimeout(r, 0));
      expect(h.sends).toEqual(['raced send']); // hit the wire once
      const s = getSnapshot(id);
      expect(s.busy).toBe(true); // a turn IS in flight server-side
      expect(s.queue.map((q) => q.message)).toEqual(['raced send']); // parked for the drain
      expect(s.items.filter((it) => it.kind === 'msg' && it.text.startsWith('⚠'))).toEqual([]); // no error chip

      h.state.reject409 = false;
      routeChatFrame(frame(id, { kind: 'done', sessionId: 'sess_race', costUsd: 0 }));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.sends).toEqual(['raced send', 'raced send']); // drained for real
    } finally {
      h.restore();
    }
  });

  test('rehydrate applies the transcript’s busy (a mid-run opener missed the init frame)', async () => {
    const id = 'chat_midrun_open';
    const h = harness(id, { config: {}, events: [], busy: true });
    try {
      await new Promise((r) => setTimeout(r, 0)); // openStream → rehydrate
      expect(getSnapshot(id).busy).toBe(true);
    } finally {
      h.restore();
    }
  });
});

// The canvas chat starter (CEDA-189MC6) types the opening prompt BEFORE the chat exists,
// so it can't send: send() no-ops until the session is subscribed. The prompt is armed
// against the shape id and claimed by the chat's view once its stream is live.
describe('armed first prompt', () => {
  test('an armed prompt is claimed exactly once', () => {
    armFirstPrompt('chat_armed', 'build me a kanban');
    expect(takeFirstPrompt('chat_armed')).toBe('build me a kanban');
    expect(takeFirstPrompt('chat_armed')).toBe(''); // a remount must not re-send it
  });

  test('a chat with nothing armed claims nothing', () => {
    expect(takeFirstPrompt('chat_unarmed')).toBe('');
  });

  test('arming is per chat — one chat never claims another’s prompt', () => {
    armFirstPrompt('chat_a', 'prompt a');
    armFirstPrompt('chat_b', 'prompt b');
    expect(takeFirstPrompt('chat_b')).toBe('prompt b');
    expect(takeFirstPrompt('chat_a')).toBe('prompt a');
  });

  test('an empty prompt arms nothing (a bare "New chat" still starts empty)', () => {
    armFirstPrompt('chat_empty', '');
    expect(takeFirstPrompt('chat_empty')).toBe('');
  });
});
