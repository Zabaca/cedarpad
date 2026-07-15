// The turn lifecycle (server/turn.ts), tested under fakes — the settle path that was previously
// reachable ONLY through a live SDK turn. runTurnAsync is the awaitable form; a fake runChat
// stands in for the agent so we assert the phase ORDER (setup → run → settle) and, crucially,
// the race fix: the settle-time Conversation upsert must await the row-at-start index, so the
// two find-or-create-by-chat calls can never insert two rows for one chat.

import { describe, expect, test } from 'bun:test';

import type { ChatEvent } from './agent.ts';
import { type TurnDeps, type TurnInput, runTurnAsync } from './turn.ts';

// A minimal fake CanvasSession — the fake runChat ignores the store, so a marker object suffices.
const fakeSession = { store: {}, requestScreenshot: () => {}, canvasId: 'default' } as unknown as Awaited<
  ReturnType<TurnDeps['getSession']>
>;

/** A recording deps bag: every collaborator pushes its name to `calls` so we can assert order. */
function recordingDeps(overrides: Partial<TurnDeps> = {}): { deps: TurnDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: TurnDeps = {
    aborters: new Map(),
    flavor: () => ({ workspaceId: 'default', kind: 'chat' as const, skills: ['impeccable', 'tdd'] }),
    getSession: async () => {
      calls.push('getSession');
      return fakeSession;
    },
    defaultCanvasId: 'default',
    prepareDevAgent: async () => {
      calls.push('prepareDevAgent');
      return undefined;
    },
    // Default fake turn: init (assigns the session id) then done. Overridable per test.
    runChat: (async function* () {
      calls.push('runChat');
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'],
    bumpSharedModuleAcrossCanvases: () => 0,
    broadcast: (_chatId, ev) => calls.push(`broadcast:${ev.kind}`),
    inbox: { db: {} as never, userId: 'u', notify: () => {} },
    indexSession: async () => {
      calls.push('indexSession');
    },
    stampSession: () => calls.push('stampSession'),
    onTurnComplete: async () => {
      calls.push('onTurnComplete');
    },
    settleConversation: async () => {
      calls.push('settleConversation');
    },
    backupTranscript: async () => {
      calls.push('backupTranscript');
    },
    ...overrides,
  };
  return { deps, calls };
}

const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  chatId: 'chat_1',
  message: 'draw a box',
  sessionId: null,
  images: [],
  canvasId: 'default',
  ...over,
});

describe('runTurnAsync: the turn phase order', () => {
  test('setup → run (broadcast each event) → settle, in that order', async () => {
    const { deps, calls } = recordingDeps();

    await runTurnAsync(input(), deps);

    expect(calls).toEqual([
      'getSession',
      'prepareDevAgent',
      'runChat',
      'indexSession', // row-at-start, on the init event
      'broadcast:init',
      'broadcast:done',
      // settle, after the run drains:
      'stampSession', // null → 'sess_1' is a change, so the resume pointer is stamped
      'onTurnComplete',
      'settleConversation',
      'backupTranscript',
    ]);
  });

  test('the AbortController is registered synchronously and cleared at settle', async () => {
    const { deps } = recordingDeps();
    const p = runTurnAsync(input({ chatId: 'chat_sync' }), deps);

    // Set BEFORE the first await resolves — a concurrent /send must see the in-flight turn.
    expect(deps.aborters.has('chat_sync')).toBe(true);

    await p;
    expect(deps.aborters.has('chat_sync')).toBe(false); // cleared in finally
  });

  test('a resume (sessionId unchanged) does NOT re-stamp the resume pointer', async () => {
    // runChat echoes the SAME session id it was resumed with — no new/forked id.
    const runChat = (async function* () {
      yield { kind: 'done', sessionId: 'sess_keep', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    const { deps, calls } = recordingDeps({ runChat });

    await runTurnAsync(input({ sessionId: 'sess_keep' }), deps);

    expect(calls).not.toContain('stampSession');
    expect(calls).toContain('settleConversation');
  });
});

describe('runTurnAsync: the race fix (settle awaits the row-at-start index)', () => {
  test('settleConversation runs only AFTER indexSession resolves', async () => {
    const order: string[] = [];
    let releaseIndex!: () => void;
    const indexGate = new Promise<void>((r) => {
      releaseIndex = r;
    });

    const { deps } = recordingDeps({
      indexSession: async () => {
        order.push('index:start');
        await indexGate; // simulate a slow row-at-start insert
        order.push('index:done');
      },
      settleConversation: async () => {
        order.push('settle');
      },
    });

    const turn = runTurnAsync(input(), deps);

    // Let the run drain to the finally block, where it must be parked awaiting the index.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['index:start']); // settle has NOT run — it is waiting on the index

    releaseIndex();
    await turn;

    // The index resolved before settle — so the settle-time find-or-create sees the one row the
    // index created, instead of racing it into a second row (ownerRef has no unique constraint).
    expect(order).toEqual(['index:start', 'index:done', 'settle']);
  });

  test('a failed index never blocks settle (best-effort — the turn still records activity)', async () => {
    const { deps, calls } = recordingDeps({
      indexSession: async () => {
        throw new Error('turso hiccup');
      },
    });

    await runTurnAsync(input(), deps);

    // The rejected index is swallowed; settle + backup still run so the turn is not lost.
    expect(calls).toContain('settleConversation');
    expect(calls).toContain('backupTranscript');
  });
});

describe('runTurnAsync: the error path', () => {
  test('runChat throwing broadcasts a done-error frame and still runs onTurnComplete', async () => {
    const runChat = (async function* () {
      yield { kind: 'init', sessionId: 'sess_err' } satisfies ChatEvent;
      throw new Error('agent blew up');
      // eslint-disable-next-line no-unreachable
    }) as unknown as TurnDeps['runChat'];

    const broadcasts: ChatEvent[] = [];
    const { deps, calls } = recordingDeps({
      runChat,
      broadcast: (_chatId, ev) => broadcasts.push(ev),
    });

    await runTurnAsync(input(), deps);

    const errFrame = broadcasts.find((e) => e.kind === 'done' && e.error);
    expect(errFrame).toMatchObject({ kind: 'done', error: 'agent blew up' });
    // The finally still settles (the init assigned a session id, so the row is upserted + backed up).
    expect(calls).toContain('onTurnComplete');
    expect(calls).toContain('settleConversation');
    // And the aborter is cleaned up even on the error path.
    expect(deps.aborters.has('chat_1')).toBe(false);
  });

  test('an error before any session id is known skips the inbox settle (nothing to index)', async () => {
    const runChat = (async function* (): AsyncGenerator<ChatEvent> {
      throw new Error('died before init');
    }) as unknown as TurnDeps['runChat'];
    const { deps, calls } = recordingDeps({ runChat });

    await runTurnAsync(input(), deps);

    expect(calls).toContain('onTurnComplete'); // persistence still flushes
    expect(calls).not.toContain('settleConversation'); // no sessionId ⇒ no Conversation row
    expect(calls).not.toContain('backupTranscript');
  });
});

// Canvas pairing: the EXPLICIT request canvas is both the routing target and the chat→canvas
// edge claim; an unaddressed turn routes to the default store but claims NO edge.
describe('the request canvas: routing vs edge claim', () => {
  test('an addressed turn routes to that canvas and claims it at index + settle', async () => {
    const routed: string[] = [];
    const claimed: Array<string | undefined> = [];
    const { deps } = recordingDeps({
      getSession: async (id) => {
        routed.push(id);
        return fakeSession;
      },
      indexSession: async (_c, _s, _m, _w, canvasId) => void claimed.push(canvasId),
      settleConversation: async (i) => void claimed.push(i.canvasId),
    });
    await runTurnAsync(input({ canvasId: 'cv_7' }), deps);
    expect(routed).toEqual(['cv_7']);
    expect(claimed).toEqual(['cv_7', 'cv_7']);
  });

  test('an unaddressed turn routes to the default but claims nothing', async () => {
    const routed: string[] = [];
    const claimed: Array<string | undefined> = [];
    const { deps } = recordingDeps({
      getSession: async (id) => {
        routed.push(id);
        return fakeSession;
      },
      indexSession: async (_c, _s, _m, _w, canvasId) => void claimed.push(canvasId),
      settleConversation: async (i) => void claimed.push(i.canvasId),
    });
    await runTurnAsync(input({ canvasId: undefined }), deps);
    expect(routed).toEqual(['default']);
    expect(claimed).toEqual([undefined, undefined]);
  });
});

// ADR-0013 train 2 (#176): external MCP is CHAT FLAVOR ONLY. `input.mcpTokens` is whatever rode
// the request (decoded from the edge's x-mcp-tokens header, server/bridge.ts); this turn must
// only ever hand it to runChat when `flavor.kind === 'chat'` — a dev-agent turn gets none, no
// matter what the request carried (defense in depth alongside the edge's own gating).
describe('mcpTokens: dropped for a dev-agent turn regardless of what rode the request', () => {
  test('a chat-flavor turn passes mcpTokens through to runChat', async () => {
    let seen: Record<string, string> | undefined;
    const runChat = (async function* (...args: unknown[]): AsyncGenerator<ChatEvent> {
      seen = args[16] as Record<string, string> | undefined;
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    const { deps } = recordingDeps({
      flavor: () => ({ workspaceId: 'default', kind: 'chat' as const }),
      runChat,
    });

    await runTurnAsync(input({ mcpTokens: { ledgerbot: 'tok_a' } }), deps);

    expect(seen).toEqual({ ledgerbot: 'tok_a' });
  });

  test('a dev-agent-flavor turn never passes mcpTokens to runChat, even if the request carried some', async () => {
    let seen: Record<string, string> | undefined = { should: 'not-see-this' };
    const runChat = (async function* (...args: unknown[]): AsyncGenerator<ChatEvent> {
      seen = args[16] as Record<string, string> | undefined;
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    const { deps } = recordingDeps({
      flavor: () => ({ workspaceId: 'default', kind: 'dev-agent' as const, skills: ['impeccable'] }),
      runChat,
    });

    await runTurnAsync(input({ mcpTokens: { ledgerbot: 'tok_a' }, devAgentGitToken: 'ghs_x' }), deps);

    expect(seen).toBeUndefined();
  });

  test('the flavor kind reaches runChat (chat drops Write/Edit there; dev-agent keeps them)', async () => {
    const seen: unknown[] = [];
    const runChat = (async function* (...args: unknown[]): AsyncGenerator<ChatEvent> {
      seen.push(args[17]);
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    const chat = recordingDeps({ flavor: () => ({ workspaceId: 'default', kind: 'chat' as const }), runChat });
    await runTurnAsync(input(), chat.deps);
    const dev = recordingDeps({
      flavor: () => ({ workspaceId: 'default', kind: 'dev-agent' as const, skills: ['impeccable'] }),
      runChat,
    });
    await runTurnAsync(input({ devAgentGitToken: 'ghs_x' }), dev.deps);

    expect(seen).toEqual(['chat', 'dev-agent']);
  });

  test('no mcpTokens on the request ⇒ undefined reaches runChat for a chat turn too', async () => {
    let seen: Record<string, string> | undefined = { should: 'not-see-this' };
    const runChat = (async function* (...args: unknown[]): AsyncGenerator<ChatEvent> {
      seen = args[16] as Record<string, string> | undefined;
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    const { deps } = recordingDeps({ flavor: () => ({ workspaceId: 'default', kind: 'chat' as const }), runChat });

    await runTurnAsync(input(), deps);

    expect(seen).toBeUndefined();
  });
});
