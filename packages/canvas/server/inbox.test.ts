import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { makeDb, conversations } from '../web-poc/lib/db/index.ts';
import { memBackend } from './blob-store.ts';
import { projectDirForCwd, transcriptKey } from './transcript-r2.ts';
import { askHuman, findOrCreateConversation, resumeConversation } from './inbox.ts';

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
});
