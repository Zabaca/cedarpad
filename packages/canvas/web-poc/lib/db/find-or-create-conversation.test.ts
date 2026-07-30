import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrationStatements } from "./test-support.js";
import { makeDb } from "./index.js";
import * as conversations from "./queries/conversations.js";
import { findOrCreateConversation } from "./find-or-create-conversation.js";

// `findOrCreateConversation` is platform data layer (root CONTEXT.md), so its tests belong with
// it. They lived in `server/inbox.test.ts` while `server/` re-exported it; ADR-0018 / #266 took
// the container's database away, and with it the last reason for that re-export.

async function freshDb() {
  const client = createClient({ url: ":memory:" });
  for (const stmt of migrationStatements()) await client.execute(stmt);
  return makeDb(client);
}

// The Conversation's identity is the CHAT (ownerRef), not the SDK session: resume mints a
// new sessionId per turn, and keying rows by sessionId created one duplicate row per turn.
describe('findOrCreateConversation: chat identity (ownerRef)', () => {
  it('a new turn on the same chat REUSES the row and re-points sessionId (no duplicate)', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 'sess-1', userId: 'u', workspaceId: 'w', ownerRef: 'chat_A', summary: 'first message' });
    // Next turn: resume minted a NEW sessionId for the same chat.
    const b = await findOrCreateConversation(db, { sessionId: 'sess-2', userId: 'u', workspaceId: 'w', ownerRef: 'chat_A', summary: 'first message' });
    expect(b.id).toBe(a.id);
    expect(b.sessionId).toBe('sess-2'); // the resume pointer follows the newest session
    expect(await conversations.list(db)).toHaveLength(1);
  });

  it('a human initiator (assignTo) claims the row at birth; absent ⇒ unassigned (cron)', async () => {
    const db = await freshDb();
    const human = await findOrCreateConversation(db, { sessionId: 's-h', userId: 'canvas-user', workspaceId: 'w', ownerRef: 'chat_H', assignTo: 'james' });
    expect(human.assignedTo).toBe('james');
    expect(human.userId).toBe('canvas-user'); // creator attribution untouched
    const cron = await findOrCreateConversation(db, { sessionId: 's-c', userId: 'canvas-user', workspaceId: 'w', ownerRef: 'chat_C' });
    expect(cron.assignedTo).toBeNull();
  });

  it('a reply into an UNASSIGNED row auto-claims it for the replier; an assigned row is never stolen', async () => {
    const db = await freshDb();
    const born = await findOrCreateConversation(db, { sessionId: 's-1', userId: 'canvas-user', workspaceId: 'w', ownerRef: 'chat_R' });
    expect(born.assignedTo).toBeNull();
    // James replies (next turn, new resume sessionId): the unassigned row becomes his.
    const claimed = await findOrCreateConversation(db, { sessionId: 's-2', userId: 'canvas-user', workspaceId: 'w', ownerRef: 'chat_R', assignTo: 'james' });
    expect(claimed.id).toBe(born.id);
    expect(claimed.assignedTo).toBe('james');
    // Sam replies later: assignment is advisory but never silently re-targeted by a reply.
    const kept = await findOrCreateConversation(db, { sessionId: 's-3', userId: 'canvas-user', workspaceId: 'w', ownerRef: 'chat_R', assignTo: 'sam' });
    expect(kept.assignedTo).toBe('james');
  });

  it('a legacy row (found by sessionId, no ownerRef) gets its ownerRef backfilled', async () => {
    const db = await freshDb();
    const legacy = await conversations.create(db, { sessionId: 'sess-old', userId: 'u', workspaceId: 'w', summary: 'old' });
    const found = await findOrCreateConversation(db, { sessionId: 'sess-old', userId: 'u', workspaceId: 'w', ownerRef: 'chat_B' });
    expect(found.id).toBe(legacy.id);
    expect((await conversations.getByOwnerRef(db, 'chat_B'))?.id).toBe(legacy.id);
  });

  it('a canvas-born chat records its canvas edge at creation', async () => {
    const db = await freshDb();
    const born = await findOrCreateConversation(db, { sessionId: 's-cv', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c1', canvasId: 'cv_1' });
    expect(born.canvasId).toBe('cv_1');
  });

  it('a later turn carrying a canvas backfills a null edge but never overwrites one', async () => {
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

  it('a turn with no canvas (inbox reply, dev-agent run) leaves the edge untouched', async () => {
    const db = await freshDb();
    await findOrCreateConversation(db, { sessionId: 's-1', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c3', canvasId: 'cv_9' });
    const later = await findOrCreateConversation(db, { sessionId: 's-2', userId: 'u', workspaceId: 'w', ownerRef: 'shape:c3' });
    expect(later.canvasId).toBe('cv_9');
  });
});

// Dev-agent is a session KIND, not a workspace: rows file under the workspace they run in,
// and `kind` carries the type (the edge's token mint keys on it).
describe('findOrCreateConversation: session kind', () => {
  it('a dev-agent turn creates a dev-agent-kinded row in its real workspace', async () => {
    const db = await freshDb();
    const conv = await findOrCreateConversation(db, { sessionId: 's-da', userId: 'u', workspaceId: 'default', kind: 'dev-agent', ownerRef: 'chat_da' });
    expect(conv.kind).toBe('dev-agent');
    expect(conv.workspaceId).toBe('default');
  });

  it('kind defaults to chat', async () => {
    const db = await freshDb();
    const conv = await findOrCreateConversation(db, { sessionId: 's-c', userId: 'u', workspaceId: 'w', ownerRef: 'chat_c' });
    expect(conv.kind).toBe('chat');
  });
});

describe('findOrCreateConversation', () => {
  it('returns the existing row on a second call for the same session', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 's-idem', userId: 'u', workspaceId: 'w', summary: 'x' });
    const b = await findOrCreateConversation(db, { sessionId: 's-idem', userId: 'u', workspaceId: 'w', summary: 'y' });
    expect(b.id).toBe(a.id);
    expect(b.summary).toBe('x'); // create-only: the first title sticks, later turns don't overwrite it
  });

  it('a later call for an existing session touches lastActivity (a new turn sorts it to the top)', async () => {
    const db = await freshDb();
    const a = await findOrCreateConversation(db, { sessionId: 's-touch', userId: 'u', workspaceId: 'w', summary: 'x' });
    // Age the row, then simulate the next turn's find-or-create.
    await conversations.touch(db, a.id, new Date(Date.now() - 60_000));
    const b = await findOrCreateConversation(db, { sessionId: 's-touch', userId: 'u', workspaceId: 'w', summary: 'x' });
    expect(b.lastActivity.getTime()).toBeGreaterThan(a.lastActivity.getTime() - 30_000);
    expect(b.lastActivity.getTime()).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });

  it('a plain session lands in waiting_on:none — it shows in "All" but NOT in the "Needs me" view', async () => {
    // The unified session index (every session gets a row) must not pollute the default attention
    // view: a session that never called ask_human stays waiting_on:none until (if) it promotes.
    const db = await freshDb();
    await findOrCreateConversation(db, { sessionId: 's-plain', userId: 'u', workspaceId: 'w', summary: 'hello' });
    expect((await conversations.list(db, { waitingOn: 'human' })).length).toBe(0);
    expect((await conversations.list(db)).map((c) => c.sessionId)).toContain('s-plain');
  });
});
