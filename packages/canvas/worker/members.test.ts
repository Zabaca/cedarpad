import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { addWorkspaceMember, createWorkspace, getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
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
