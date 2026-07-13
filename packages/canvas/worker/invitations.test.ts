import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { listPendingInvitations } from '../web-poc/lib/db/queries/invitations.ts';
import { addWorkspaceMember, createWorkspace, getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { handleInvitationsApi, handleInviteAccept } from './invitations.ts';

// In-memory DB built from the real migrations (mirrors shell.test.ts).
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

const OWNER = { id: 'owner_1', email: 'owner_1@example.com' };
const MEMBER = { id: 'member_1', email: 'member_1@example.com' };
const STRANGER = { id: 'stranger_1', email: 'stranger_1@example.com' };

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const u of [OWNER, MEMBER, STRANGER]) {
    await db.insert(schema.user).values({ id: u.id, name: u.id, email: u.email });
  }
});

const inviteReq = (method: string, body?: unknown) =>
  new Request('https://x/api/workspaces/whatever/invitations', {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

describe('handleInvitationsApi — owner-only issuance/list/revoke (#179)', () => {
  test('the owner invites an email and gets a link token; the invitation is listed pending', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws', ownerUserId: OWNER.id });
    const res = await handleInvitationsApi(inviteReq('POST', { email: 'Jae@Example.com' }), database, OWNER, ws.id);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.url).toBe(`/invite/${body.token}`);
    expect(body.email).toBe('jae@example.com'); // normalized binding

    const listed = await readJson(await handleInvitationsApi(inviteReq('GET'), database, OWNER, ws.id));
    expect(listed.invitations.map((i: { token: string }) => i.token)).toContain(body.token);
  });

  test('a member cannot invite (admin is owner-only); a stranger sees no workspace at all', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-2', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    const asMember = await handleInvitationsApi(inviteReq('POST', { email: 'x@example.com' }), database, MEMBER, ws.id);
    expect(asMember.status).toBe(403);
    const asStranger = await handleInvitationsApi(inviteReq('POST', { email: 'x@example.com' }), database, STRANGER, ws.id);
    expect(asStranger.status).toBe(404);
  });

  test('an invalid email is a 400', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-3', ownerUserId: OWNER.id });
    const res = await handleInvitationsApi(inviteReq('POST', { email: 'not-an-email' }), database, OWNER, ws.id);
    expect(res.status).toBe(400);
  });

  test('the owner revokes a pending invitation', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-4', ownerUserId: OWNER.id });
    const { token } = await readJson(
      await handleInvitationsApi(inviteReq('POST', { email: 'gone@example.com' }), database, OWNER, ws.id),
    );
    const res = await handleInvitationsApi(inviteReq('DELETE'), database, OWNER, ws.id, token);
    expect(res.status).toBe(204);
    expect(await listPendingInvitations(database, ws.id, Date.now())).toHaveLength(0);
  });
});

// The accept flow: GET renders (never consumes — link prefetch must be safe); POST
// consumes. Account creation happens ONLY through this path (signup stays disabled
// globally) via the injected signUp seam.
describe('handleInviteAccept — the only signup door (#179)', () => {
  const mint = async (email: string) => {
    const ws = await createWorkspace(database, { name: `acc-${crypto.randomUUID()}`, ownerUserId: OWNER.id });
    const { token } = await readJson(
      await handleInvitationsApi(inviteReq('POST', { email }), database, OWNER, ws.id),
    );
    return { ws, token: token as string };
  };
  const noSignUp = async () => {
    throw new Error('signUp must not be called');
  };

  test('GET renders the join page for a valid token and does not consume it', async () => {
    const { ws, token } = await mint('new_1@example.com');
    const res = await handleInviteAccept(new Request(`https://x/invite/${token}`), database, null, token, { signUp: noSignUp });
    expect(res.status).toBe(200);
    expect(await listPendingInvitations(database, ws.id, Date.now())).toHaveLength(1);
  });

  test('GET for an unknown token is a 404 page', async () => {
    const res = await handleInviteAccept(new Request('https://x/invite/wi_nope'), database, null, 'wi_nope', { signUp: noSignUp });
    expect(res.status).toBe(404);
  });

  test('POST with a signed-in matching session joins without creating an account', async () => {
    const { ws, token } = await mint(MEMBER.email);
    const res = await handleInviteAccept(
      new Request(`https://x/invite/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      database,
      MEMBER,
      token,
      { signUp: noSignUp },
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).workspaceId).toBe(ws.id);
    expect((await getWorkspace(database, ws.id, MEMBER.id))?.id).toBe(ws.id);
  });

  test('POST with a signed-in NON-matching session is rejected and grants nothing', async () => {
    const { ws, token } = await mint('someoneelse@example.com');
    const res = await handleInviteAccept(
      new Request(`https://x/invite/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      database,
      STRANGER,
      token,
      { signUp: noSignUp },
    );
    expect(res.status).toBe(403);
    expect(await getWorkspace(database, ws.id, STRANGER.id)).toBeNull();
  });

  test('POST with no session creates the account via the seam (bound email only) and joins', async () => {
    const { ws, token } = await mint('fresh@example.com');
    const calls: Array<{ email: string; name: string; password: string }> = [];
    const signUp = async (input: { email: string; name: string; password: string }) => {
      calls.push(input);
      const id = 'fresh_user_1';
      await db.insert(schema.user).values({ id, name: input.name, email: input.email });
      return { userId: id, setCookie: 'session=abc; HttpOnly' };
    };

    const res = await handleInviteAccept(
      new Request(`https://x/invite/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Fresh', password: 'hunter22222' }),
      }),
      database,
      null,
      token,
      { signUp },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('session=abc');
    expect(calls).toEqual([{ email: 'fresh@example.com', name: 'Fresh', password: 'hunter22222' }]);
    expect((await getWorkspace(database, ws.id, 'fresh_user_1'))?.id).toBe(ws.id);

    // single-use: the consumed token cannot be accepted again
    const again = await handleInviteAccept(
      new Request(`https://x/invite/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      database,
      MEMBER,
      token,
      { signUp: noSignUp },
    );
    expect(again.status).toBe(410);
  });

  test('POST with no session and no password never touches signUp', async () => {
    const { token } = await mint('nopw@example.com');
    const res = await handleInviteAccept(
      new Request(`https://x/invite/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      database,
      null,
      token,
      { signUp: noSignUp },
    );
    expect(res.status).toBe(400);
  });
});
