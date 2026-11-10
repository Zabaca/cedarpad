import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { addWorkspaceMember, createWorkspace, getWorkspace, getWorkspaceRecord } from '../web-poc/lib/db/queries/workspaces.ts';
import { handleMembersApi } from './members.ts';

// In-memory DB built from the real migrations (mirrors invitations.test.ts).
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

const OWNER = { id: 'owner_m1', email: 'owner_m1@example.com' };
const MEMBER = { id: 'member_m1', email: 'member_m1@example.com' };
const STRANGER = { id: 'stranger_m1', email: 'stranger_m1@example.com' };

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const u of [OWNER, MEMBER, STRANGER]) {
    await db.insert(schema.user).values({ id: u.id, name: `name of ${u.id}`, email: u.email });
  }
});

const req = (method: string) => new Request('https://x/api/workspaces/whatever/members', { method });
const reqPatch = (body: unknown) =>
  new Request('https://x/api/workspaces/whatever/members', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('handleMembersApi — the member list is workspace-visible, removal is owner-only (#192)', () => {
  test('owner and member both read the roster: owner first with role owner, then members', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    for (const viewer of [OWNER, MEMBER]) {
      const res = await handleMembersApi(req('GET'), database, viewer, ws.id);
      expect(res.status).toBe(200);
      const { members } = await readJson(res);
      expect(members).toEqual([
        { userId: OWNER.id, name: `name of ${OWNER.id}`, email: OWNER.email, role: 'owner' },
        { userId: MEMBER.id, name: `name of ${MEMBER.id}`, email: MEMBER.email, role: 'member' },
      ]);
    }
  });

  test('a stranger sees no workspace at all (404)', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-2', ownerUserId: OWNER.id });
    const res = await handleMembersApi(req('GET'), database, STRANGER, ws.id);
    expect(res.status).toBe(404);
  });

  test('the owner removes a member; the removed member loses workspace access', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-3', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    const res = await handleMembersApi(req('DELETE'), database, OWNER, ws.id, MEMBER.id);
    expect(res.status).toBe(204);
    expect(await getWorkspace(database, ws.id, MEMBER.id)).toBeNull();
    const { members } = await readJson(await handleMembersApi(req('GET'), database, OWNER, ws.id));
    expect(members.map((m: { userId: string }) => m.userId)).toEqual([OWNER.id]);
  });

  test('a member cannot remove anyone (403); the owner cannot remove themselves (400)', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-4', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    expect((await handleMembersApi(req('DELETE'), database, MEMBER, ws.id, OWNER.id)).status).toBe(403);
    expect((await handleMembersApi(req('DELETE'), database, OWNER, ws.id, OWNER.id)).status).toBe(400);
    // removing a non-member is a 404
    expect((await handleMembersApi(req('DELETE'), database, OWNER, ws.id, STRANGER.id)).status).toBe(404);
  });
});

describe('handleMembersApi — owner adds an existing user as a member (ADR-0014 manual invite)', () => {
  const reqPost = (body: unknown) =>
    new Request('https://x/api/workspaces/whatever/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('the owner adds a user; the roster shows them; re-adding is a no-op', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-add', ownerUserId: OWNER.id });
    for (let i = 0; i < 2; i++) {
      const res = await handleMembersApi(reqPost({ userId: STRANGER.id }), database, OWNER, ws.id);
      expect(res.status).toBe(200);
      const { members } = await readJson(res);
      expect(members.map((m: { userId: string }) => m.userId)).toEqual([OWNER.id, STRANGER.id]);
    }
  });

  test('a member cannot add (403); a bad body is 400', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-add-2', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });
    expect((await handleMembersApi(reqPost({ userId: STRANGER.id }), database, MEMBER, ws.id)).status).toBe(403);
    expect((await handleMembersApi(reqPost({}), database, OWNER, ws.id)).status).toBe(400);
  });
});

describe('handleMembersApi — role change IS ownership transfer (single owner model)', () => {
  test('the owner transfers ownership to a member: roles swap, roster reflects it', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-5', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    const res = await handleMembersApi(reqPatch({ role: 'owner' }), database, OWNER, ws.id, MEMBER.id);
    expect(res.status).toBe(200);
    const { members } = await readJson(res);
    expect(members).toEqual([
      { userId: MEMBER.id, name: `name of ${MEMBER.id}`, email: MEMBER.email, role: 'owner' },
      { userId: OWNER.id, name: `name of ${OWNER.id}`, email: OWNER.email, role: 'member' },
    ]);
    const record = await getWorkspaceRecord(database, ws.id);
    expect(record?.ownerUserId).toBe(MEMBER.id);
  });

  test('a member calling PATCH is 403', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-6', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    const res = await handleMembersApi(reqPatch({ role: 'owner' }), database, MEMBER, ws.id, OWNER.id);
    expect(res.status).toBe(403);
  });

  test('transferring to a non-member is 404', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-7', ownerUserId: OWNER.id });
    const res = await handleMembersApi(reqPatch({ role: 'owner' }), database, OWNER, ws.id, STRANGER.id);
    expect(res.status).toBe(404);
  });

  test('transferring to self is 400', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-8', ownerUserId: OWNER.id });
    const res = await handleMembersApi(reqPatch({ role: 'owner' }), database, OWNER, ws.id, OWNER.id);
    expect(res.status).toBe(400);
  });

  test('a bad body (e.g. role: member) is 400', async () => {
    const ws = await createWorkspace(database, { name: 'mem-ws-9', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    const res = await handleMembersApi(reqPatch({ role: 'member' }), database, OWNER, ws.id, MEMBER.id);
    expect(res.status).toBe(400);
  });
});
