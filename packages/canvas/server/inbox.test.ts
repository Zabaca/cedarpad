import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memBackend } from './blob-store.ts';
import { projectDirForCwd, TranscriptStore, transcriptKey } from './transcript-store.ts';
import { endTurn, openConversation, placeChatCard } from './inbox.ts';
import type { PlatformRpc } from './platform-rpc-client.ts';
import type { TurnEndInput } from '../shared/platform-rpc.ts';
import { makeStopGate } from './agent.ts';

// ADR-0018 / #266: the container holds NO platform-data-layer client, so nothing in this file
// builds one. `end_turn` is tested against a RECORDING platform RPC — the container's whole
// contribution is which operation it names and with what, because the edge owns the row (the
// transitions themselves are asserted in worker/platform-rpc.test.ts against a real database).

/** A recording platform RPC: every operation the container can reach, and what it was asked. */
function recordingRpc(overrides: Partial<PlatformRpc> = {}) {
  const turnEnds: TurnEndInput[] = [];
  const rpc: PlatformRpc = {
    conversationStart: async () => {},
    conversationSettle: async () => {},
    conversationPrOpened: async () => {},
    turnEnd: async (input) => {
      turnEnds.push(input);
      return { conversationId: `conv_for_${input.sessionId}` };
    },
    notify: async () => {},
    ...overrides,
  };
  return { rpc, turnEnds };
}

describe('end_turn protocol (ADR-0012)', () => {
  test('needs_human: asks the edge to end the turn, then rings the doorbell for the row it filed', async () => {
    const { rpc, turnEnds } = recordingRpc();
    const notified: Array<{ id: string; question: string }> = [];
    const sessionId = 'sess-ask-1';

    const text = await endTurn(
      {
        rpc,
        getSessionId: () => sessionId,
        userId: 'user_a',
        workspaceId: 'ws_a',
        ownerRef: 'chat_ask',
        notify: (id, question) => void notified.push({ id, question }),
      },
      { outcome: 'needs_human', summary: 'Need approval', question: 'Ship it?' },
    );

    // Returns agent-facing text (non-blocking): it never awaited a human reply.
    expect(text).toContain('Inbox');
    expect(text.toLowerCase()).toContain('end your turn');

    // ONE named operation carried the whole ending — outcome and question included.
    expect(turnEnds).toEqual([
      {
        sessionId,
        userId: 'user_a',
        workspaceId: 'ws_a',
        kind: undefined,
        ownerRef: 'chat_ask',
        summary: 'Need approval',
        outcome: 'needs_human',
        question: 'Ship it?',
      },
    ]);

    // The doorbell names the Conversation BY ID — the container never held the row.
    expect(notified).toEqual([{ id: `conv_for_${sessionId}`, question: 'Ship it?' }]);
  });

  test('done: declares the ending and never pings the human', async () => {
    const { rpc, turnEnds } = recordingRpc();
    const notified: string[] = [];

    const text = await endTurn(
      { rpc, getSessionId: () => 'sess-done-1', userId: 'user_a', workspaceId: 'ws_a', notify: (_id, q) => void notified.push(q) },
      { outcome: 'done', summary: 'Committed #3; nothing pending' },
    );

    expect(text.toLowerCase()).toContain('done');
    expect(turnEnds[0]).toMatchObject({ outcome: 'done', summary: 'Committed #3; nothing pending' });
    expect(turnEnds[0]!.question).toBeUndefined(); // a completed turn asks nothing
    expect(notified).toHaveLength(0);
  });

  test('with no session id yet, end_turn degrades and asks the edge for nothing', async () => {
    const { rpc, turnEnds } = recordingRpc();
    const text = await endTurn(
      { rpc, getSessionId: () => null, userId: 'user_a', workspaceId: 'ws_a' },
      { outcome: 'needs_human', summary: 's', question: 'q' },
    );
    expect(text.toLowerCase()).toContain('unavailable');
    expect(turnEnds).toHaveLength(0);
  });

  // Best-effort by contract (ADR-0018): the hop can fail exactly as the write could, and the
  // agent still gets its answer. Without a filed row there is no handle, so no doorbell.
  test('an unreachable edge still answers the agent, and rings no doorbell', async () => {
    const { rpc } = recordingRpc({ turnEnd: async () => null });
    const notified: string[] = [];

    const text = await endTurn(
      { rpc, getSessionId: () => 'sess-down', userId: 'u', workspaceId: 'w', notify: (id) => void notified.push(id) },
      { outcome: 'needs_human', summary: 's', question: 'q' },
    );

    expect(text).toContain('Inbox');
    expect(notified).toHaveLength(0);
  });

  // A bridge with no edge in front of it (rpc: null) is now a DEGRADED bridge, not one with a
  // local fallback — #266 removed the fallback. It must still answer the tool.
  test('with no edge configured at all, the tool still answers rather than throwing', async () => {
    const text = await endTurn(
      { rpc: null, getSessionId: () => 'sess-no-edge', userId: 'u', workspaceId: 'w' },
      { outcome: 'done', summary: 'finished' },
    );
    expect(text.toLowerCase()).toContain('done');
  });
});

// ADR-0012: the Stop-hook gate — a turn may not end without an end_turn declaration.
describe('makeStopGate', () => {
  test('blocks a stop until end_turn ran, then approves', async () => {
    let ended = false;
    const gate = makeStopGate(() => ended, () => false);
    expect((await gate()).decision).toBe('block');
    ended = true;
    expect((await gate()).decision).toBeUndefined();
  });

  test('gives up after maxBlocks refusals (guardrail, not a cage)', async () => {
    const gate = makeStopGate(() => false, () => false, 2);
    expect((await gate()).decision).toBe('block');
    expect((await gate()).decision).toBe('block');
    expect((await gate()).decision).toBeUndefined(); // 3rd stop passes ungated
  });

  test('a user-aborted turn is exempt', async () => {
    const gate = makeStopGate(() => false, () => true);
    expect((await gate()).decision).toBeUndefined();
  });
});

// Opening an Inbox Conversation as a live <ChatView> on its owning bridge (ADR-0009, #124):
// ensure the session JSONL is on the runner FS (restore from R2 iff the container cold-booted,
// never clobbering a warm/live copy), then resolve the chatId the Shell subscribes to —
// `chatIdForSession(sessionId) ?? conv.id` — and seed that chatId's ChatMeta so its transcript
// + send resume THIS session.
describe('openConversation', () => {
  const mkDir = () => join(tmpdir(), `Tmp_Open_${process.pid}_${Math.random().toString(36).slice(2)}`);

  test('cold container: restores the JSONL from R2 and resolves the homing canvas chat id (one stream, two views)', async () => {
    const sessionId = 'sess-open-1';
    const cwd = '/workspace/app';
    // The forwarded row (#261): three fields, arriving on a header — never read from a database.
    const conv = { id: 'conv-open-1', sessionId, ownerRef: null };

    const blobs = memBackend();
    await blobs.put(transcriptKey(sessionId), new TextEncoder().encode('{"type":"user"}\n'));

    const projectsDir = mkDir();
    const seeded: Array<[string, string]> = [];
    try {
      const { chatId } = await openConversation(
        {
          transcripts: new TranscriptStore(blobs, projectsDir),
          cwd,
          chatIdForSession: (sid) => (sid === sessionId ? 'shape:chat_home' : undefined),
          seedChatMeta: (cid, sid) => void seeded.push([cid, sid]),
        },
        conv,
      );

      // The chatId is the CANVAS chat's id, so the canvas card and this Inbox view are two live
      // views of one bridge stream (same chatId), auto-consistent.
      expect(chatId).toBe('shape:chat_home');
      // The cold container had no local JSONL, so restore landed it on disk (resume + transcript read).
      expect(existsSync(join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`))).toBe(true);
      expect(seeded).toEqual([['shape:chat_home', sessionId]]);
    } finally {
      if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  test('headless session (no canvas chat home): falls back to conv.id and seeds its ChatMeta', async () => {
    const sessionId = 'sess-open-2';
    const conv = { id: 'conv-open-2', sessionId, ownerRef: null };

    const blobs = memBackend();
    await blobs.put(transcriptKey(sessionId), new TextEncoder().encode('{"type":"user"}\n'));

    const projectsDir = mkDir();
    const seeded: Array<[string, string]> = [];
    try {
      const { chatId } = await openConversation(
        {
          transcripts: new TranscriptStore(blobs, projectsDir),
          cwd: '/workspace/app',
          chatIdForSession: () => undefined,
          seedChatMeta: (cid, sid) => void seeded.push([cid, sid]),
        },
        conv,
      );

      expect(chatId).toBe(conv.id);
      // The fallback chatId has no ChatMeta yet, so it MUST be seeded to conv.sessionId or its
      // transcript + send would resolve the wrong (empty) session.
      expect(seeded).toEqual([[conv.id, sessionId]]);
    } finally {
      if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  test('warm container: a live on-disk JSONL is NOT clobbered by a stale R2 restore', async () => {
    const sessionId = 'sess-open-3';
    const cwd = '/workspace/app';
    const conv = { id: 'conv-open-3', sessionId, ownerRef: null };

    const projectsDir = mkDir();
    const diskPath = join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`);
    await Bun.write(diskPath, 'LIVE');

    const blobs = memBackend();
    await blobs.put(transcriptKey(sessionId), new TextEncoder().encode('STALE'));

    try {
      await openConversation(
        { transcripts: new TranscriptStore(blobs, projectsDir), cwd, chatIdForSession: () => undefined, seedChatMeta: () => {} },
        conv,
      );
      // The on-disk copy is authoritative for a warm/live session; restore must be skipped.
      expect(readFileSync(diskPath, 'utf8')).toBe('LIVE');
    } finally {
      if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});

// Canvas pairing, container half (ADR-0018 / #264): the row work — linking the Conversation,
// creating a canvas for an empty body, and the same-workspace check — is the edge's now, so all
// the bridge still does is place a live chat card shape on the canvas the edge paired, from the
// pairing it forwarded.
describe('placeChatCard', () => {
  const fakeCanvas = () => {
    const upserted: Array<Record<string, unknown>> = [];
    const sessions: string[] = [];
    return {
      upserted,
      sessions,
      getSession: (canvasId: string) => {
        sessions.push(canvasId);
        return Promise.resolve({
          canvasId,
          shapes: () => [
            { id: 'shape:existing', type: 'note', x: 100, y: 50, w: 200, h: 200 },
          ],
          upsert: (shapes: Array<Record<string, unknown>>) => void upserted.push(...shapes),
        });
      },
    };
  };

  const pairing = {
    id: 'conv_att',
    sessionId: 's-att',
    ownerRef: 'chat_att',
    canvasId: 'cv_board',
    summary: 'Explore the pricing model options',
  };

  test('places a chat card on the paired canvas, fronting the EXISTING chat, in free space', async () => {
    const cv = fakeCanvas();

    await placeChatCard({ getSession: cv.getSession, chatIdForSession: () => null }, pairing);

    expect(cv.sessions).toEqual(['cv_board']);
    expect(cv.upserted).toHaveLength(1);
    const card = cv.upserted[0]!;
    expect(card.type).toBe('chat');
    expect(card.chatId).toBe('chat_att'); // the durable owner pointer
    expect(String(card.id)).toStartWith('shape:');
    expect(Number(card.x)).toBeGreaterThan(300); // right of the existing note (x 100 + w 200)
  });

  test('a LIVE canvas chat wins the chatId (two views of one stream)', async () => {
    const cv = fakeCanvas();

    await placeChatCard({ getSession: cv.getSession, chatIdForSession: () => 'chat_live' }, pairing);

    expect(cv.upserted[0]!.chatId).toBe('chat_live');
  });
});

