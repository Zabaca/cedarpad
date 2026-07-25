import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import {
  listVisibleConversations,
  resolveCanvas,
  resolveCanvasWorkspace,
  resolveConversationById,
  resolveConversationByOwnerRef,
} from './access.ts';

// The access SEAM (#225): membership + ADR-0016 visibility composed once. Driven against a
// real in-memory libSQL built from the migrations (same harness style as inbox.test.ts), so
// the join the predicates need is the real one.
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

const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

const OWNER = 'user_owner';
const MEMBER = 'user_member';
const STRANGER = 'user_stranger';

let wsId: string;
let publicCanvasId: string;
let privateCanvasId: string; // private, created by OWNER

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const id of [OWNER, MEMBER, STRANGER]) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
  await db.insert(schema.workspaces).values({ id: 'default', name: 'Default', ownerUserId: OWNER });
  const ws = await createWorkspace(database, { name: 'AccessWs', ownerUserId: OWNER });
  wsId = ws.id;
  await db.insert(schema.workspaceMembers).values({ id: 'wm_access', workspaceId: wsId, userId: MEMBER });

  publicCanvasId = (await canvasRegistry.create(database, { workspaceId: wsId, name: 'Public', createdBy: OWNER })).id;
  const priv = await canvasRegistry.create(database, { workspaceId: wsId, name: 'Private', createdBy: OWNER });
  await canvasRegistry.setVisibility(database, priv.id, 'private');
  privateCanvasId = priv.id;
});

let seq = 0;
const makeConv = async (o: {
  createdBy: string;
  canvasId?: string;
  visibility?: 'shared' | 'private';
  workspaceId?: string;
}) => {
  const n = ++seq;
  const row = await conversations.create(database, {
    sessionId: `s_${n}`,
    userId: 'system',
    workspaceId: o.workspaceId ?? wsId,
    ownerRef: `chat_${n}`,
    canvasId: o.canvasId ?? null,
    createdBy: o.createdBy,
  });
  if (o.visibility === 'private') await conversations.setVisibility(database, row.id, 'private');
  return { ...row, visibility: o.visibility ?? row.visibility };
};

describe('resolveConversationByOwnerRef / resolveConversationById (membership + ADR-0016)', () => {
  test('a member sees a shared conversation; both handles agree', async () => {
    const conv = await makeConv({ createdBy: OWNER });
    expect((await resolveConversationByOwnerRef(database, conv.ownerRef!, MEMBER))?.id).toBe(conv.id);
    expect((await resolveConversationById(database, conv.id, MEMBER))?.id).toBe(conv.id);
  });

  test('a non-member gets null — same as a missing row (no existence leak)', async () => {
    const conv = await makeConv({ createdBy: OWNER });
    expect(await resolveConversationByOwnerRef(database, conv.ownerRef!, STRANGER)).toBeNull();
    expect(await resolveConversationById(database, conv.id, STRANGER)).toBeNull();
    expect(await resolveConversationByOwnerRef(database, 'chat_nope', OWNER)).toBeNull();
    expect(await resolveConversationById(database, 'nope', OWNER)).toBeNull();
  });

  test("a private chat is hidden from another member, visible to its creator", async () => {
    const conv = await makeConv({ createdBy: OWNER, visibility: 'private' });
    expect(await resolveConversationById(database, conv.id, MEMBER)).toBeNull();
    expect((await resolveConversationById(database, conv.id, OWNER))?.id).toBe(conv.id);
  });

  test('a conversation on a private canvas is hidden from a member who is not the canvas creator', async () => {
    const conv = await makeConv({ createdBy: OWNER, canvasId: privateCanvasId });
    expect(await resolveConversationById(database, conv.id, MEMBER)).toBeNull();
    expect((await resolveConversationById(database, conv.id, OWNER))?.id).toBe(conv.id);
  });

  test('canvas privacy DOMINATES: a private canvas hides its chats even from the chat creator', async () => {
    const conv = await makeConv({ createdBy: MEMBER, canvasId: privateCanvasId });
    // MEMBER created the chat but not the canvas — the canvas leg still hides it (ADR-0016).
    expect(await resolveConversationById(database, conv.id, MEMBER)).toBeNull();
    expect(await resolveConversationByOwnerRef(database, conv.ownerRef!, MEMBER)).toBeNull();
  });

  test('a public canvas does not hide its chats', async () => {
    const conv = await makeConv({ createdBy: OWNER, canvasId: publicCanvasId });
    expect((await resolveConversationById(database, conv.id, MEMBER))?.id).toBe(conv.id);
  });
});

describe('resolveCanvas (workspace-scoped)', () => {
  test('a member resolves a workspace-visible canvas', async () => {
    expect((await resolveCanvas(database, wsId, publicCanvasId, MEMBER))?.id).toBe(publicCanvasId);
  });

  test('a non-member gets null', async () => {
    expect(await resolveCanvas(database, wsId, publicCanvasId, STRANGER)).toBeNull();
  });

  test("someone else's private canvas is null; its creator resolves it", async () => {
    expect(await resolveCanvas(database, wsId, privateCanvasId, MEMBER)).toBeNull();
    expect((await resolveCanvas(database, wsId, privateCanvasId, OWNER))?.id).toBe(privateCanvasId);
  });

  test('a canvas from another workspace is null even for a member of both', async () => {
    const other = await createWorkspace(database, { name: 'Other', ownerUserId: OWNER });
    expect(await resolveCanvas(database, other.id, publicCanvasId, OWNER)).toBeNull();
    expect(await resolveCanvas(database, wsId, 'cv_missing', OWNER)).toBeNull();
  });
});

describe('resolveCanvasWorkspace (canvas addressed without its workspace)', () => {
  test('derives the workspace for a member; null for a stranger', async () => {
    expect(await resolveCanvasWorkspace(database, publicCanvasId, MEMBER)).toBe(wsId);
    expect(await resolveCanvasWorkspace(database, publicCanvasId, STRANGER)).toBeNull();
  });

  test('the legacy row-less `default` canvas maps to the default workspace', async () => {
    expect(await resolveCanvasWorkspace(database, 'default', OWNER)).toBe('default');
    expect(await resolveCanvasWorkspace(database, 'default', STRANGER)).toBeNull();
  });

  test("a private canvas is its creator's business only", async () => {
    expect(await resolveCanvasWorkspace(database, privateCanvasId, MEMBER)).toBeNull();
    expect(await resolveCanvasWorkspace(database, privateCanvasId, OWNER)).toBe(wsId);
  });
});

describe('listVisibleConversations (batched canvas join)', () => {
  test('drops private chats and private-canvas chats, keeps the rest, honors list opts', async () => {
    const listWs = await createWorkspace(database, { name: 'ListWs', ownerUserId: OWNER });
    await db.insert(schema.workspaceMembers).values({ id: 'wm_list', workspaceId: listWs.id, userId: MEMBER });
    const priv = await canvasRegistry.create(database, { workspaceId: listWs.id, name: 'P', createdBy: OWNER });
    await canvasRegistry.setVisibility(database, priv.id, 'private');

    const shared = await makeConv({ createdBy: OWNER, workspaceId: listWs.id });
    const privChat = await makeConv({ createdBy: OWNER, workspaceId: listWs.id, visibility: 'private' });
    const onPrivCanvas = await makeConv({ createdBy: MEMBER, workspaceId: listWs.id });
    const linked = await conversations.create(database, {
      sessionId: 's_linked',
      userId: 'system',
      workspaceId: listWs.id,
      ownerRef: 'chat_linked',
      canvasId: priv.id,
      createdBy: MEMBER,
    });

    const asMember = await listVisibleConversations(database, listWs.id, MEMBER);
    expect(asMember.map((r) => r.id).sort()).toEqual([shared.id, onPrivCanvas.id].sort());

    const asOwner = await listVisibleConversations(database, listWs.id, OWNER);
    expect(asOwner.map((r) => r.id).sort()).toEqual([shared.id, privChat.id, onPrivCanvas.id, linked.id].sort());

    // list opts pass through (the closed archive is empty here)
    expect(await listVisibleConversations(database, listWs.id, OWNER, { status: 'closed' })).toEqual([]);
  });
});
