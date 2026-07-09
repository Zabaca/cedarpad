import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { makeDb, conversations } from '../web-poc/lib/db/index.ts';
import { memBackend } from './blob-store.ts';
import { projectDirForCwd, transcriptKey } from './transcript-r2.ts';
import { askHuman, findOrCreateConversation, openConversation, resumeConversation } from './inbox.ts';

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

describe('ask_human promote protocol', () => {
  test('promotes the session Conversation (creating it), fires notify, returns without blocking', async () => {
    const db = await freshDb();
    const notified: Array<{ id: string; question: string }> = [];
    const sessionId = 'sess-ask-1';

    const text = await askHuman(
      {
        db,
        getSessionId: () => sessionId,
        userId: 'user_a',
        workspaceId: 'ws_a',
        notify: (conv, question) => void notified.push({ id: conv.id, question }),
      },
      { summary: 'Need approval', question: 'Ship it?' },
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
  });

  test('find-or-create by sessionId is idempotent: a second ask_human updates, not duplicates', async () => {
    const db = await freshDb();
    const sessionId = 'sess-ask-2';
    const deps = { db, getSessionId: () => sessionId, userId: 'user_a', workspaceId: 'ws_a' };

    await askHuman(deps, { summary: 'first', question: 'q1' });
    const first = await conversations.getBySessionId(db, sessionId);

    // Human replies, handing the turn back; agent asks again on the SAME session.
    await conversations.reply(db, first!.id);
    await askHuman(deps, { summary: 'second', question: 'q2' });

    const all = await conversations.list(db, 'user_a');
    const forSession = all.filter((c) => c.sessionId === sessionId);
    expect(forSession).toHaveLength(1); // no duplicate row
    expect(forSession[0]?.id).toBe(first!.id);
    expect(forSession[0]?.waitingOn).toBe('human'); // re-promoted, not left on agent
    expect(forSession[0]?.unread).toBe(true);
  });

  test('with no session id yet, ask_human degrades and creates nothing', async () => {
    const db = await freshDb();
    const text = await askHuman(
      { db, getSessionId: () => null, userId: 'user_a', workspaceId: 'ws_a' },
      { summary: 's', question: 'q' },
    );
    expect(text.toLowerCase()).toContain('unavailable');
    expect(await conversations.list(db, 'user_a')).toHaveLength(0);
  });
});

describe('findOrCreateConversation', () => {
  test('returns the existing row on a second call for the same session', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 's-idem', userId: 'u', workspaceId: 'w', summary: 'x' });
    const b = await findOrCreateConversation(db, { sessionId: 's-idem', userId: 'u', workspaceId: 'w', summary: 'y' });
    expect(b.id).toBe(a.id);
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

  // ADR-0009 Tier 2 / #125: a dev-agent Conversation resumes on the DEV-AGENT runner's own
  // interactive bridge. resumeConversation is runner-agnostic (the caller supplies cwd + runTurn),
  // so the only dev-agent-specific requirement is that restore lands the explore-session JSONL at
  // the cwd the resume reads. On the dev-agent runner both the explore session (dev-agent-run.ts,
  // `cwd: repoRoot`) and the interactive bridge (bridge.ts, CANVAS_CWD) default to the container's
  // process.cwd() — the canvas package dir — so they encode to the SAME SDK project dir. That
  // shared cwd is the invariant this test pins: restore reconstructs exactly the path resume reads.
  test('resumes on the dev-agent runner: restore lands the explore-session JSONL at the runner cwd resume path', async () => {
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
