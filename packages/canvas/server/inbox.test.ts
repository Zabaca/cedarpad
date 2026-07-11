import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { makeDb, conversations } from '../web-poc/lib/db/index.ts';
import { memBackend } from './blob-store.ts';
import { projectDirForCwd, transcriptKey } from './transcript-r2.ts';
import { attachConversationToCanvas, backfillCanvasEdges, dedupeLegacyConversations, endTurn, findOrCreateConversation, openConversation, resumeConversation } from './inbox.ts';
import { makeStopGate } from './agent.ts';

// In-memory DB built from the real Drizzle migrations (mirrors conversations.test.ts, bun:test).
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}

async function freshDb() {
  const client = createClient({ url: ':memory:' });
  for (const stmt of migrationStatements()) await client.execute(stmt);
  return makeDb(client);
}

describe('end_turn protocol (ADR-0012)', () => {
  test('needs_human: promotes the session Conversation (creating it), fires notify, returns without blocking', async () => {
    const db = await freshDb();
    const notified: Array<{ id: string; question: string }> = [];
    const sessionId = 'sess-ask-1';

    const text = await endTurn(
      {
        db,
        getSessionId: () => sessionId,
        userId: 'user_a',
        workspaceId: 'ws_a',
        notify: (conv, question) => void notified.push({ id: conv.id, question }),
      },
      { outcome: 'needs_human', summary: 'Need approval', question: 'Ship it?' },
    );

    // Returns agent-facing text (non-blocking): it never awaited a human reply.
    expect(text).toContain('Inbox');
    expect(text.toLowerCase()).toContain('end your turn');

    const conv = await conversations.getBySessionId(db, sessionId);
    expect(conv).not.toBeNull();
    expect(conv?.status).toBe('open');
    expect(conv?.waitingOn).toBe('human');
    expect(conv?.unread).toBe(true);
    expect(conv?.summary).toBe('Need approval');

    // Notify fired with the promoted conversation + the question.
    expect(notified).toHaveLength(1);
    expect(notified[0]?.id).toBe(conv!.id);
    expect(notified[0]?.question).toBe('Ship it?');
    // The row's preview is the question, so the Inbox list shows WHAT is being asked.
    expect(conv?.lastMessagePreview).toBe('Ship it?');
  });

  test('done: records completion — waiting_on:none, unread, preview = the summary, no notify', async () => {
    const db = await freshDb();
    const notified: string[] = [];
    const sessionId = 'sess-done-1';

    const text = await endTurn(
      { db, getSessionId: () => sessionId, userId: 'user_a', workspaceId: 'ws_a', notify: (_c, q) => void notified.push(q) },
      { outcome: 'done', summary: 'Committed #3; nothing pending' },
    );

    expect(text.toLowerCase()).toContain('done');
    const conv = await conversations.getBySessionId(db, sessionId);
    expect(conv?.waitingOn).toBe('none'); // stays OUT of "Needs me"
    expect(conv?.unread).toBe(true); // but "All" shows the activity dot
    expect(conv?.lastMessagePreview).toBe('Committed #3; nothing pending');
    expect(notified).toHaveLength(0); // done never pings the human
  });

  test('find-or-create by sessionId is idempotent: a second end_turn updates, not duplicates', async () => {
    const db = await freshDb();
    const sessionId = 'sess-ask-2';
    const deps = { db, getSessionId: () => sessionId, userId: 'user_a', workspaceId: 'ws_a' };

    await endTurn(deps, { outcome: 'needs_human', summary: 'first', question: 'q1' });
    const first = await conversations.getBySessionId(db, sessionId);

    // Human replies, handing the turn back; agent asks again on the SAME session.
    await conversations.reply(db, first!.id);
    await endTurn(deps, { outcome: 'needs_human', summary: 'second', question: 'q2' });

    const all = await conversations.list(db, 'user_a');
    const forSession = all.filter((c) => c.sessionId === sessionId);
    expect(forSession).toHaveLength(1); // no duplicate row
    expect(forSession[0]?.id).toBe(first!.id);
    expect(forSession[0]?.waitingOn).toBe('human'); // re-promoted, not left on agent
    expect(forSession[0]?.unread).toBe(true);
  });

  test('with no session id yet, end_turn degrades and creates nothing', async () => {
    const db = await freshDb();
    const text = await endTurn(
      { db, getSessionId: () => null, userId: 'user_a', workspaceId: 'ws_a' },
      { outcome: 'needs_human', summary: 's', question: 'q' },
    );
    expect(text.toLowerCase()).toContain('unavailable');
    expect(await conversations.list(db, 'user_a')).toHaveLength(0);
  });
});

// The Conversation's identity is the CHAT (ownerRef), not the SDK session: resume mints a
// new sessionId per turn, and keying rows by sessionId created one duplicate row per turn.
describe('findOrCreateConversation: chat identity (ownerRef)', () => {
  test('a new turn on the same chat REUSES the row and re-points sessionId (no duplicate)', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 'sess-1', userId: 'u', workspaceId: 'w', ownerRef: 'chat_A', summary: 'first message' });
    // Next turn: resume minted a NEW sessionId for the same chat.
    const b = await findOrCreateConversation(db, { sessionId: 'sess-2', userId: 'u', workspaceId: 'w', ownerRef: 'chat_A', summary: 'first message' });
    expect(b.id).toBe(a.id);
    expect(b.sessionId).toBe('sess-2'); // the resume pointer follows the newest session
    expect(await conversations.list(db, 'u')).toHaveLength(1);
  });

  test('a legacy row (found by sessionId, no ownerRef) gets its ownerRef backfilled', async () => {
    const db = await freshDb();
    const legacy = await conversations.create(db, { sessionId: 'sess-old', userId: 'u', workspaceId: 'w', summary: 'old' });
    const found = await findOrCreateConversation(db, { sessionId: 'sess-old', userId: 'u', workspaceId: 'w', ownerRef: 'chat_B' });
    expect(found.id).toBe(legacy.id);
    expect((await conversations.getByOwnerRef(db, 'chat_B'))?.id).toBe(legacy.id);
  });

  test('a canvas-born chat records its canvas edge at creation', async () => {
    const db = await freshDb();
    const born = await findOrCreateConversation(db, { sessionId: 's-cv', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c1', canvasId: 'cv_1' });
    expect(born.canvasId).toBe('cv_1');
  });

  test('a later turn carrying a canvas backfills a null edge but never overwrites one', async () => {
    const db = await freshDb();
    const bare = await findOrCreateConversation(db, { sessionId: 's-a', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c2' });
    expect(bare.canvasId).toBeNull();
    // The chat's canvas shows up on a later turn (e.g. after the pad starts stamping it).
    const filled = await findOrCreateConversation(db, { sessionId: 's-b', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c2', canvasId: 'cv_1' });
    expect(filled.canvasId).toBe('cv_1');
    // First wins: a conflicting claim never re-homes the chat.
    const kept = await findOrCreateConversation(db, { sessionId: 's-c', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c2', canvasId: 'cv_2' });
    expect(kept.canvasId).toBe('cv_1');
  });

  test('a turn with no canvas (inbox reply, dev-agent run) leaves the edge untouched', async () => {
    const db = await freshDb();
    await findOrCreateConversation(db, { sessionId: 's-1', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c3', canvasId: 'cv_9' });
    const later = await findOrCreateConversation(db, { sessionId: 's-2', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c3' });
    expect(later.canvasId).toBe('cv_9');
  });
});

describe('dedupeLegacyConversations: collapse the per-turn duplicate rows', () => {
  test('keeps the best legacy row per (workspace, summary) — waiting_on:human wins — and deletes the rest', async () => {
    const db = await freshDb();
    // Three dupes of one chat (same summary), one of them promoted; plus an unrelated row.
    const d1 = await conversations.create(db, { sessionId: 's1', userId: 'u', workspaceId: 'w', summary: 'explore run' });
    const d2 = await conversations.create(db, { sessionId: 's2', userId: 'u', workspaceId: 'w', summary: 'explore run' });
    await conversations.promote(db, d2.id);
    const d3 = await conversations.create(db, { sessionId: 's3', userId: 'u', workspaceId: 'w', summary: 'explore run' });
    const other = await conversations.create(db, { sessionId: 's4', userId: 'u', workspaceId: 'w', summary: 'different chat' });

    const removed = await dedupeLegacyConversations(db, 'u');
    expect(removed).toBe(2);
    const left = await conversations.list(db, 'u');
    expect(left.map((c) => c.id).sort()).toEqual([d2.id, other.id].sort()); // promoted row survives
    void d1;
    void d3;
  });

  test('rows keyed by ownerRef are never touched, and a second run is a no-op', async () => {
    const db = await freshDb();
    await conversations.create(db, { sessionId: 's1', userId: 'u', workspaceId: 'w', ownerRef: 'chat_1', summary: 'same title' });
    await conversations.create(db, { sessionId: 's2', userId: 'u', workspaceId: 'w', ownerRef: 'chat_2', summary: 'same title' });
    expect(await dedupeLegacyConversations(db, 'u')).toBe(0);
    expect(await conversations.list(db, 'u')).toHaveLength(2);
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

describe('findOrCreateConversation', () => {
  test('returns the existing row on a second call for the same session', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 's-idem', userId: 'u', workspaceId: 'w', summary: 'x' });
    const b = await findOrCreateConversation(db, { sessionId: 's-idem', userId: 'u', workspaceId: 'w', summary: 'y' });
    expect(b.id).toBe(a.id);
    expect(b.summary).toBe('x'); // create-only: the first title sticks, later turns don't overwrite it
  });

  test('a later call for an existing session touches lastActivity (a new turn sorts it to the top)', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 's-touch', userId: 'u', workspaceId: 'w', summary: 'x' });
    // Age the row, then simulate the next turn's find-or-create.
    await conversations.touch(db, a.id, new Date(Date.now() - 60_000));
    const b = await findOrCreateConversation(db, { sessionId: 's-touch', userId: 'u', workspaceId: 'w', summary: 'x' });
    expect(b.lastActivity.getTime()).toBeGreaterThan(a.lastActivity.getTime() - 30_000);
    expect(b.lastActivity.getTime()).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });

  test('a plain session lands in waiting_on:none — it shows in "All" but NOT in the "Needs me" view', async () => {
    // The unified session index (every session gets a row) must not pollute the default attention
    // view: a session that never called ask_human stays waiting_on:none until (if) it promotes.
    const db = await freshDb();
    await findOrCreateConversation(db, { sessionId: 's-plain', userId: 'u', workspaceId: 'w', summary: 'hello' });
    expect((await conversations.list(db, 'u', { waitingOn: 'human' })).length).toBe(0);
    expect((await conversations.list(db, 'u')).map((c) => c.sessionId)).toContain('s-plain');
  });
});

describe('resumeConversation', () => {
  test('restores the transcript from R2, resumes with the reply, flips waiting_on:agent', async () => {
    const db = await freshDb();
    const sessionId = 'sess-resume-1';
    const cwd = '/workspace/app';

    // A promoted (waiting_on:human) Conversation whose transcript sits in R2.
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'w' });
    await conversations.promote(db, conv.id);

    const getter = memBackend();
    const jsonl = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n';
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode(jsonl));

    const projectsDir = join(tmpdir(), `Tmp_InboxResume_${process.pid}_${Math.random().toString(36).slice(2)}`);
    const ran: Array<{ sessionId: string; message: string; transcriptOnDisk: boolean }> = [];
    try {
      const updated = await resumeConversation(
        {
          db,
          getter,
          projectsDir,
          cwd,
          // Assert restore happened BEFORE the turn: the JSONL must already be on disk here.
          runTurn: (sid, msg) => {
            const onDisk = existsSync(join(projectsDir, projectDirForCwd(cwd), `${sid}.jsonl`));
            ran.push({ sessionId: sid, message: msg, transcriptOnDisk: onDisk });
          },
        },
        conv,
        'here is my answer',
      );

      expect(ran).toHaveLength(1);
      expect(ran[0]?.sessionId).toBe(sessionId);
      expect(ran[0]?.message).toBe('here is my answer');
      expect(ran[0]?.transcriptOnDisk).toBe(true); // restore ran before runTurn

      expect(updated?.waitingOn).toBe('agent');
      expect(updated?.unread).toBe(false);
    } finally {
      if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  test('forwards the reply images to runTurn (unified reply/send contract, #123)', async () => {
    const db = await freshDb();
    const sessionId = 'sess-resume-img';
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'w' });
    await conversations.promote(db, conv.id);

    const getter = memBackend();
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode('{"type":"user"}\n'));

    const images = [{ media_type: 'image/png', data: 'AAAA' }];
    const ran: Array<{ images: unknown }> = [];
    await resumeConversation(
      {
        db,
        getter,
        projectsDir: join(tmpdir(), `Tmp_InboxImg_${process.pid}_${Math.random().toString(36).slice(2)}`),
        cwd: '/workspace/app',
        runTurn: (_sid, _msg, imgs) => void ran.push({ images: imgs }),
      },
      conv,
      'look at this',
      images,
    );

    // The human's pasted images reach the resumed turn — not dropped to [].
    expect(ran).toHaveLength(1);
    expect(ran[0]?.images).toEqual(images);
  });

  test('with no images, runTurn receives an empty array (back-compat)', async () => {
    const db = await freshDb();
    const sessionId = 'sess-resume-noimg';
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'w' });
    await conversations.promote(db, conv.id);

    const getter = memBackend();
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode('{"type":"user"}\n'));

    const ran: Array<{ images: unknown }> = [];
    await resumeConversation(
      {
        db,
        getter,
        projectsDir: join(tmpdir(), `Tmp_InboxNoImg_${process.pid}_${Math.random().toString(36).slice(2)}`),
        cwd: '/workspace/app',
        runTurn: (_sid, _msg, imgs) => void ran.push({ images: imgs }),
      },
      conv,
      'text only',
    );

    expect(ran).toHaveLength(1);
    expect(ran[0]?.images).toEqual([]);
  });

  // resumeConversation is runner-agnostic (the caller supplies cwd + runTurn); the invariant
  // this test pins is that restore lands the session JSONL at exactly the path a resume under
  // that cwd reads (projectDirForCwd). (Dev-agent turns move the JSONL onward to their
  // prepared worktree's project dir via adoptSession — ADR-0010 slice 6 / ADR-0011.)
  test('restore lands the session JSONL at the cwd resume path', async () => {
    const db = await freshDb();
    const sessionId = 'sess-dev-agent-explore';
    // The dev-agent container cwd shared by its explore session and its interactive bridge.
    const devAgentRunnerCwd = '/app/agent-canvas/packages/canvas';

    // A dev-agent Conversation (workspaceId = dev-agent) whose explore transcript sits in R2.
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'dev-agent' });
    await conversations.promote(db, conv.id);

    const getter = memBackend();
    const jsonl = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"explore"}]}}\n';
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode(jsonl));

    const projectsDir = join(tmpdir(), `Tmp_DevAgentResume_${process.pid}_${Math.random().toString(36).slice(2)}`);
    const resumePath = join(projectsDir, projectDirForCwd(devAgentRunnerCwd), `${sessionId}.jsonl`);
    let onDiskAtResume = false;
    try {
      const updated = await resumeConversation(
        {
          db,
          getter,
          projectsDir,
          cwd: devAgentRunnerCwd,
          // The resumed turn (query({ resume })) reads exactly this path — assert it's present.
          runTurn: () => void (onDiskAtResume = existsSync(resumePath)),
        },
        conv,
        'approve candidate 1',
      );

      expect(onDiskAtResume).toBe(true); // restore reconstructed the exact SDK resume path
      expect(updated?.waitingOn).toBe('agent'); // reply flips it off the attention list
    } finally {
      if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
    }
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
    const db = await freshDb();
    const sessionId = 'sess-open-1';
    const cwd = '/workspace/app';
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'w' });

    const getter = memBackend();
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode('{"type":"user"}\n'));

    const projectsDir = mkDir();
    const seeded: Array<[string, string]> = [];
    try {
      const { chatId } = await openConversation(
        {
          getter,
          projectsDir,
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
    const db = await freshDb();
    const sessionId = 'sess-open-2';
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'w' });

    const getter = memBackend();
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode('{"type":"user"}\n'));

    const projectsDir = mkDir();
    const seeded: Array<[string, string]> = [];
    try {
      const { chatId } = await openConversation(
        {
          getter,
          projectsDir,
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
    const db = await freshDb();
    const sessionId = 'sess-open-3';
    const cwd = '/workspace/app';
    const conv = await conversations.create(db, { sessionId, userId: 'u', workspaceId: 'w' });

    const projectsDir = mkDir();
    const diskPath = join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`);
    await Bun.write(diskPath, 'LIVE');

    const getter = memBackend();
    await getter.put(transcriptKey(sessionId), new TextEncoder().encode('STALE'));

    try {
      await openConversation(
        { getter, projectsDir, cwd, chatIdForSession: () => undefined, seedChatMeta: () => {} },
        conv,
      );
      // The on-disk copy is authoritative for a warm/live session; restore must be skipped.
      expect(readFileSync(diskPath, 'utf8')).toBe('LIVE');
    } finally {
      if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});

// Lazy backfill (canvas pairing): chats born BEFORE edge capture existed live as shapes in
// canvas state but their rows have no canvas edge. When a canvas session builds, the bridge
// hands its chat-shape ids here; rows found by ownerRef get the edge — first-wins, so a row
// already linked elsewhere is never re-homed, and unknown chat ids are ignored.
describe('backfillCanvasEdges: canvas boot links pre-capture chats', () => {
  test('fills null edges by ownerRef, skips linked rows and unknown chats', async () => {
    const db = await freshDb();
    const bare = await findOrCreateConversation(db, { sessionId: 's-1', userId: 'u', workspaceId: 'w', ownerRef: 'shape:a' });
    const linked = await findOrCreateConversation(db, { sessionId: 's-2', userId: 'u', workspaceId: 'w', ownerRef: 'shape:b', canvasId: 'cv_other' });

    await backfillCanvasEdges(db, 'cv_boot', ['shape:a', 'shape:b', 'shape:unknown']);

    expect((await conversations.get(db, bare.id))?.canvasId).toBe('cv_boot');
    expect((await conversations.get(db, linked.id))?.canvasId).toBe('cv_other');
  });
});

// Attach (canvas pairing, slice 3): link a canvas-less Conversation to a canvas — existing
// (same-workspace only) or created on the spot (named from the chat summary) — writing the
// edge AND placing a live chat card shape on that canvas so the pairing is visible from both
// sides. First-wins: an already-linked Conversation is refused, never re-homed.
describe('attachConversationToCanvas', () => {
  const fakeCanvas = () => {
    const upserted: Array<Record<string, unknown>> = [];
    return {
      upserted,
      getSession: (canvasId: string) =>
        Promise.resolve({
          canvasId,
          shapes: () => [
            { id: 'shape:existing', type: 'note', x: 100, y: 50, w: 200, h: 200 },
          ],
          upsert: (shapes: Array<Record<string, unknown>>) => void upserted.push(...shapes),
        }),
    };
  };

  const setup = async () => {
    const db = await freshDb();
    const conv = await findOrCreateConversation(db, {
      sessionId: 's-att',
      userId: 'u',
      workspaceId: 'ws_a',
      ownerRef: 'chat_att',
      summary: 'Explore the pricing model options',
    });
    return { db, conv };
  };

  test('attach to an EXISTING same-workspace canvas: writes the edge and places the card', async () => {
    const { db, conv } = await setup();
    const registry = await import('../web-poc/lib/db/queries/canvases.ts');
    const target = await registry.create(db, { workspaceId: 'ws_a', name: 'Board' });
    const cv = fakeCanvas();

    const res = await attachConversationToCanvas(
      { db, getSession: cv.getSession, chatIdForSession: () => null },
      conv.id,
      { canvasId: target.id },
    );

    expect(res).toMatchObject({ ok: true, canvasId: target.id });
    expect((await conversations.get(db, conv.id))?.canvasId).toBe(target.id);
    // The card fronts the EXISTING chat (chatId = the conversation's chat), in free space.
    expect(cv.upserted).toHaveLength(1);
    const card = cv.upserted[0]!;
    expect(card.type).toBe('chat');
    expect(card.chatId).toBe('chat_att');
    expect(String(card.id)).toStartWith('shape:');
    expect(Number(card.x)).toBeGreaterThan(300); // right of the existing note (x 100 + w 200)
  });

  test('create-and-attach: a new canvas in the conversation’s workspace, named from the summary', async () => {
    const { db, conv } = await setup();
    const cv = fakeCanvas();

    const res = await attachConversationToCanvas(
      { db, getSession: cv.getSession, chatIdForSession: () => null },
      conv.id,
      {},
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    const registry = await import('../web-poc/lib/db/queries/canvases.ts');
    const made = await registry.get(db, res.canvasId);
    expect(made?.workspaceId).toBe('ws_a');
    expect(made?.name).toBe('Explore the pricing model options');
    expect((await conversations.get(db, conv.id))?.canvasId).toBe(res.canvasId);
    expect(cv.upserted).toHaveLength(1);
  });

  test('refuses an already-linked conversation (409 shape) and a cross-workspace canvas', async () => {
    const { db, conv } = await setup();
    const registry = await import('../web-poc/lib/db/queries/canvases.ts');
    const foreign = await registry.create(db, { workspaceId: 'ws_OTHER', name: 'Elsewhere' });
    const cv = fakeCanvas();
    const deps = { db, getSession: cv.getSession, chatIdForSession: () => null };

    const cross = await attachConversationToCanvas(deps, conv.id, { canvasId: foreign.id });
    expect(cross).toMatchObject({ ok: false, error: 'wrong_workspace' });

    const own = await registry.create(db, { workspaceId: 'ws_a', name: 'Mine' });
    await attachConversationToCanvas(deps, conv.id, { canvasId: own.id });
    const again = await attachConversationToCanvas(deps, conv.id, { canvasId: own.id });
    expect(again).toMatchObject({ ok: false, error: 'already_linked' });
    expect(cv.upserted).toHaveLength(1); // only the first attach placed a card
  });

  test('unknown conversation / unknown canvas → not_found', async () => {
    const { db } = await setup();
    const cv = fakeCanvas();
    const deps = { db, getSession: cv.getSession, chatIdForSession: () => null };
    expect(await attachConversationToCanvas(deps, 'conv_missing', {})).toMatchObject({ ok: false, error: 'not_found' });
    const { conv } = await setup();
    expect(await attachConversationToCanvas(deps, conv.id, { canvasId: 'cv_ghost' })).toMatchObject({ ok: false, error: 'not_found' });
  });
});

// Dev-agent is a session KIND, not a workspace: rows file under the workspace they run in,
// and `kind` carries the type (the edge's token mint keys on it).
describe('findOrCreateConversation: session kind', () => {
  test('a dev-agent turn creates a dev-agent-kinded row in its real workspace', async () => {
    const db = await freshDb();
    const conv = await findOrCreateConversation(db, { sessionId: 's-da', userId: 'u', workspaceId: 'default', kind: 'dev-agent', ownerRef: 'chat_da' });
    expect(conv.kind).toBe('dev-agent');
    expect(conv.workspaceId).toBe('default');
  });

  test('kind defaults to chat', async () => {
    const db = await freshDb();
    const conv = await findOrCreateConversation(db, { sessionId: 's-c', userId: 'u', workspaceId: 'w', ownerRef: 'chat_c' });
    expect(conv.kind).toBe('chat');
  });
});
