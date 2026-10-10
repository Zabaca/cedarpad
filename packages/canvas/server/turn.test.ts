// The turn lifecycle (server/turn.ts), tested under fakes — the settle path that was previously
// reachable ONLY through a live SDK turn. runTurnAsync is the awaitable form; a fake runChat
// stands in for the agent so we assert the phase ORDER (setup → run → settle).

import { describe, expect, test } from 'bun:test';

import type { ChatEvent } from './agent.ts';
import { type TurnDeps, type TurnInput, runTurnAsync } from './turn.ts';

// The room store the turn opens. The fake runChat ignores it, so a marker object suffices.
const fakeRoomStore = () =>
  ({
    getState: () => ({ version: 0, shapes: [] }),
    upsert: () => 0,
    remove: () => 0,
    clear: () => 0,
    flush: async () => {},
  }) as unknown as Awaited<ReturnType<TurnDeps['openCanvasRoom']>>;

/** A recording deps bag: every collaborator pushes its name to `calls` so we can assert order. */
function recordingDeps(overrides: Partial<TurnDeps> = {}): { deps: TurnDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: TurnDeps = {
    aborters: new Map(),
    materializeSkills: async () => {
      calls.push('materializeSkills');
    },
    requestScreenshot: () => async () => null,
    selectPage: () => () => 0,
    openCanvasRoom: async () => {
      calls.push('openCanvasRoom');
      return fakeRoomStore();
    },
    defaultCanvasId: 'default',
    // Default fake turn: init (assigns the session id) then done. Overridable per test.
    runChat: (async function* () {
      calls.push('runChat');
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'],
    broadcast: (_chatId, ev) => calls.push(`broadcast:${ev.kind}`),
    onSessionStart: () => calls.push('onSessionStart'),
    stampSession: () => calls.push('stampSession'),
    onTurnComplete: async () => {
      calls.push('onTurnComplete');
    },
    backupTranscript: async () => {
      calls.push('backupTranscript');
    },
    materializeTranscript: async () => {
      calls.push('materializeTranscript');
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
      // ADR-0022 / #361: the workspace's skill tree is rendered from its Records BEFORE
      // anything else, because the SDK discovers skills by scanning the filesystem while
      // `runChat` builds the turn's options — a skill that is not on disk by then does not
      // exist for this turn. There is no lazy request to hang materialization off, as there
      // is for a Component module.
      'materializeSkills',
      'openCanvasRoom',
      'runChat',
      'onSessionStart', // on the init event
      'broadcast:init',
      'broadcast:done',
      // settle, after the run drains:
      'stampSession', // null → 'sess_1' is a change, so the resume pointer is stamped
      'onTurnComplete',
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
    expect(calls).toContain('backupTranscript');
  });
});

// #356: boot no longer downloads transcripts, so the session a turn resumes has to be fetched
// by the turn itself — one object, at the moment it is needed. Before the sink was retired the
// boot restore of `sessions.tar` supplied it, which is why a cold container could resume at all.
describe('runTurnAsync: resume materializes its own session', () => {
  test('a resumed turn fetches its session BEFORE the agent runs', async () => {
    const fetched: string[] = [];
    const { deps, calls } = recordingDeps({
      materializeTranscript: async (sessionId) => {
        fetched.push(sessionId);
        calls.push('materializeTranscript');
      },
    });

    await runTurnAsync(input({ sessionId: 'sess_cold' }), deps);

    expect(fetched).toEqual(['sess_cold']);
    expect(calls.indexOf('materializeTranscript')).toBeLessThan(calls.indexOf('runChat'));
  });

  test('a fresh chat (no session yet) fetches nothing', async () => {
    const { deps, calls } = recordingDeps();

    await runTurnAsync(input({ sessionId: null }), deps);

    expect(calls).not.toContain('materializeTranscript');
  });

  // The remaining restore path must not fail OPEN (ADR-0022, "what this does NOT fix"): a fetch
  // that failed must never let the turn proceed as if the session had no history, because the
  // agent would answer from nothing and the reply would look like an ordinary one.
  test('a fetch that fails aborts the turn loudly instead of resuming with no history', async () => {
    const errors: string[] = [];
    const { deps, calls } = recordingDeps({
      materializeTranscript: async () => {
        throw new Error('R2 unreachable');
      },
      broadcast: (_chatId, ev) => {
        calls.push(`broadcast:${ev.kind}`);
        if (ev.kind === 'done' && ev.error) errors.push(ev.error);
      },
    });

    await runTurnAsync(input({ sessionId: 'sess_flaky' }), deps);

    expect(calls).not.toContain('runChat');
    expect(errors).toEqual(['R2 unreachable']);
  });
});

// #310: the agent's writes must land in the canvas's ROOM, not in the in-memory session store
// (which no browser has read since #290). The turn opens a room-backed store and hands THAT to
// runChat; the tool layer settles it after every tool call.
describe('runTurnAsync: the agent draws into the room (#310)', () => {
  test('runChat gets a room-backed store with settle points, not the raw room store', async () => {
    let handed: unknown = null;
    const raw = fakeRoomStore();
    const { deps } = recordingDeps({
      openCanvasRoom: async () => raw,
      runChat: (async function* (store: unknown) {
        handed = store;
        yield { kind: 'done', sessionId: null, costUsd: 0 } satisfies ChatEvent;
      }) as unknown as TurnDeps['runChat'],
    });

    await runTurnAsync(input(), deps);

    expect(handed).not.toBe(raw);
    expect(typeof (handed as { commit?: unknown }).commit).toBe('function');
  });

  test('the room is opened for the turn\'s OWN canvas', async () => {
    const opened: string[] = [];
    const { deps } = recordingDeps({
      openCanvasRoom: async (id: string) => {
        opened.push(id);
        return fakeRoomStore();
      },
    });

    await runTurnAsync(input({ canvasId: 'canvas_42' }), deps);
    expect(opened).toEqual(['canvas_42']);
  });

  // #297 removed the fallback that used to stand behind an absent opener (the in-memory
  // session store). A room that cannot be opened now fails the turn, loudly.
  test('a room that will not open fails the turn instead of drawing nowhere', async () => {
    const broadcasts: ChatEvent[] = [];
    const { deps } = recordingDeps({
      openCanvasRoom: async () => {
        throw new Error('room unreachable');
      },
      broadcast: (_chatId, ev) => broadcasts.push(ev),
    });

    await runTurnAsync(input(), deps);

    expect(broadcasts.find((e) => e.kind === 'done' && e.error)).toMatchObject({ error: 'room unreachable' });
  });

  // Canvas ids are global and the container's room credential reaches any room, so outside the
  // `default` workspace (defaultCanvasId null) a turn that names no canvas must fail rather than
  // draw into the `default` workspace's room.
  test('no canvas named and no default canvas ⇒ the turn fails and opens no room', async () => {
    const broadcasts: ChatEvent[] = [];
    const opened: string[] = [];
    const { deps } = recordingDeps({
      defaultCanvasId: null,
      openCanvasRoom: async (id: string) => {
        opened.push(id);
        return fakeRoomStore();
      },
      broadcast: (_chatId, ev) => broadcasts.push(ev),
    });

    await runTurnAsync(input({ canvasId: undefined }), deps);

    expect(opened).toEqual([]);
    expect(broadcasts.find((e) => e.kind === 'done' && e.error)).toMatchObject({
      error: expect.stringContaining('names no canvas'),
    });
  });
});

describe('runTurnAsync: the turn is attributed to whoever started it', () => {
  // The Records a turn's tools land name its author (ADR-0022 decision 4); runChat binds the
  // canvas tools' stores to it. A guest send has none, and nothing stands in for it.
  const lastArg = async (over: Partial<TurnInput>) => {
    let seen: unknown = 'unset';
    const runChat = (async function* (...args: unknown[]): AsyncGenerator<ChatEvent> {
      seen = args[args.length - 1];
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    await runTurnAsync(input(over), recordingDeps({ runChat }).deps);
    return seen;
  };

  test('the send’s author reaches runChat', async () => {
    expect(await lastArg({ author: 'u_jae' })).toBe('u_jae');
  });

  test('no author ⇒ null, never a fixed user', async () => {
    expect(await lastArg({})).toBeNull();
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
    // The finally still settles (the init assigned a session id, so the transcript is backed up).
    expect(calls).toContain('onTurnComplete');
    expect(calls).toContain('backupTranscript');
    // And the aborter is cleaned up even on the error path.
    expect(deps.aborters.has('chat_1')).toBe(false);
  });

  test('an error before any session id is known skips the transcript backup', async () => {
    const runChat = (async function* (): AsyncGenerator<ChatEvent> {
      throw new Error('died before init');
    }) as unknown as TurnDeps['runChat'];
    const { deps, calls } = recordingDeps({ runChat });

    await runTurnAsync(input(), deps);

    expect(calls).toContain('onTurnComplete'); // persistence still flushes
    expect(calls).not.toContain('backupTranscript');
  });
});

// The EXPLICIT request canvas is both the routing target and the chat→canvas binding; an
// unaddressed turn routes to the default store but binds nothing.
describe('the request canvas: routing vs binding', () => {
  test('an addressed turn routes to that canvas and binds the chat to it', async () => {
    const routed: string[] = [];
    const claimed: Array<string | undefined> = [];
    const { deps } = recordingDeps({
      openCanvasRoom: async (id) => {
        routed.push(id);
        return fakeRoomStore();
      },
      onSessionStart: (_c, _s, canvasId) => void claimed.push(canvasId),
    });
    await runTurnAsync(input({ canvasId: 'cv_7' }), deps);
    expect(routed).toEqual(['cv_7']);
    expect(claimed).toEqual(['cv_7']);
  });

  test('an unaddressed turn routes to the default but binds nothing', async () => {
    const routed: string[] = [];
    const claimed: Array<string | undefined> = [];
    const { deps } = recordingDeps({
      openCanvasRoom: async (id) => {
        routed.push(id);
        return fakeRoomStore();
      },
      onSessionStart: (_c, _s, canvasId) => void claimed.push(canvasId),
    });
    await runTurnAsync(input({ canvasId: undefined }), deps);
    expect(routed).toEqual(['default']);
    expect(claimed).toEqual([undefined]);
  });
});

// ADR-0013 train 2 (#176): `input.mcpTokens` is whatever rode the request (decoded from the
// edge's x-mcp-tokens header, server/bridge.ts); the turn hands it to runChat as-is.
describe('mcpTokens reach runChat', () => {
  const recordTokens = () => {
    const seen: unknown[] = [];
    const runChat = (async function* (...args: unknown[]): AsyncGenerator<ChatEvent> {
      seen.push(args[12]);
      yield { kind: 'init', sessionId: 'sess_1' } satisfies ChatEvent;
      yield { kind: 'done', sessionId: 'sess_1', costUsd: 0 } satisfies ChatEvent;
    }) as unknown as TurnDeps['runChat'];
    return { seen, runChat };
  };

  test('the request’s tokens pass through to runChat', async () => {
    const { seen, runChat } = recordTokens();
    await runTurnAsync(input({ mcpTokens: { ledgerbot: 'tok_a' } }), recordingDeps({ runChat }).deps);
    expect(seen).toEqual([{ ledgerbot: 'tok_a' }]);
  });

  test('no mcpTokens on the request ⇒ undefined reaches runChat', async () => {
    const { seen, runChat } = recordTokens();
    await runTurnAsync(input(), recordingDeps({ runChat }).deps);
    expect(seen).toEqual([undefined]);
  });
});
