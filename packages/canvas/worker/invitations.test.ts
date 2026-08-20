import { migrationStatements } from './migration-statements.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { listPendingInvitations } from '../web-poc/lib/db/queries/invitations.ts';
import { addWorkspaceMember, createWorkspace, getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { handleInvitationsApi, handleInviteAccept } from './invitations.ts';

// In-memory DB built from the real migrations (mirrors shell.test.ts).
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

/** Records the magic links the handlers ask for, so tests can assert WHERE a link
 *  was sent — the security-relevant fact is the address, which must always be the
 *  invitation's binding and never anything the caller supplied. */
function linkSpy() {
  const sent: Array<{ email: string; callbackURL: string }> = [];
  return {
    sent,
    deps: {
      sendSignInLink: async (email: string, callbackURL: string) => {
        sent.push({ email, callbackURL });
      },
    },
  };
}

describe('handleInvitationsApi — owner-only issuance/list/revoke (#179)', () => {
  test('the owner invites an email and gets a link token; the invitation is listed pending', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws', ownerUserId: OWNER.id });
    const spy = linkSpy();
    const res = await handleInvitationsApi(inviteReq('POST', { email: 'Jae@Example.com' }), database, OWNER, ws.id, undefined, spy.deps);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.url).toBe(`/invite/${body.token}`);
    expect(body.email).toBe('jae@example.com'); // normalized binding

    const listed = await readJson(
      await handleInvitationsApi(inviteReq('GET'), database, OWNER, ws.id, undefined, spy.deps),
    );
    expect(listed.invitations.map((i: { token: string }) => i.token)).toContain(body.token);
  });

  test('issuing an invitation emails the NORMALIZED address a link that lands on the join page', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-mail', ownerUserId: OWNER.id });
    const spy = linkSpy();
    const { token } = await readJson(
      await handleInvitationsApi(inviteReq('POST', { email: 'Mixed@Example.com' }), database, OWNER, ws.id, undefined, spy.deps),
    );
    expect(spy.sent).toEqual([{ email: 'mixed@example.com', callbackURL: `/invite/${token}` }]);
  });

  test('a member cannot invite (admin is owner-only); a stranger sees no workspace at all — and neither sends mail', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-2', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });
    const spy = linkSpy();

    const asMember = await handleInvitationsApi(inviteReq('POST', { email: 'x@example.com' }), database, MEMBER, ws.id, undefined, spy.deps);
    expect(asMember.status).toBe(403);
    const asStranger = await handleInvitationsApi(inviteReq('POST', { email: 'x@example.com' }), database, STRANGER, ws.id, undefined, spy.deps);
    expect(asStranger.status).toBe(404);
    // A rejected issuance must not be usable as a way to mail arbitrary addresses.
    expect(spy.sent).toEqual([]);
  });

  test('an invalid email is a 400 and sends nothing', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-3', ownerUserId: OWNER.id });
    const spy = linkSpy();
    const res = await handleInvitationsApi(inviteReq('POST', { email: 'not-an-email' }), database, OWNER, ws.id, undefined, spy.deps);
    expect(res.status).toBe(400);
    expect(spy.sent).toEqual([]);
  });

  test('the owner revokes a pending invitation', async () => {
    const ws = await createWorkspace(database, { name: 'inv-ws-4', ownerUserId: OWNER.id });
    const spy = linkSpy();
    const { token } = await readJson(
      await handleInvitationsApi(inviteReq('POST', { email: 'gone@example.com' }), database, OWNER, ws.id, undefined, spy.deps),
    );
    const res = await handleInvitationsApi(inviteReq('DELETE'), database, OWNER, ws.id, token, spy.deps);
    expect(res.status).toBe(204);
    expect(await listPendingInvitations(database, ws.id, Date.now())).toHaveLength(0);
  });
});

// The accept flow: GET renders (never consumes — link prefetch must be safe); POST
// consumes. Since the passwordless cutover this handler creates NOTHING: the invitee
// arrives already signed in, because the invitation email was a magic link pointing
// here. Without a session it can only re-send that link to the bound address.
describe('handleInviteAccept — join, never sign up (#179, passwordless)', () => {
  const mint = async (email: string) => {
    const ws = await createWorkspace(database, { name: `acc-${crypto.randomUUID()}`, ownerUserId: OWNER.id });
    const { token } = await readJson(
      await handleInvitationsApi(inviteReq('POST', { email }), database, OWNER, ws.id, undefined, linkSpy().deps),
    );
    return { ws, token: token as string };
  };

  const post = (token: string) =>
    new Request(`https://x/invite/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

  test('GET renders the join page for a valid token and does not consume it', async () => {
    const { ws, token } = await mint('new_1@example.com');
    const res = await handleInviteAccept(new Request(`https://x/invite/${token}`), database, null, token, linkSpy().deps);
    expect(res.status).toBe(200);
    expect(await listPendingInvitations(database, ws.id, Date.now())).toHaveLength(1);
  });

  test('GET for an unknown token is a 404 page', async () => {
    const res = await handleInviteAccept(new Request('https://x/invite/wi_nope'), database, null, 'wi_nope', linkSpy().deps);
    expect(res.status).toBe(404);
  });

  test('POST with a signed-in matching session joins without creating an account', async () => {
    const { ws, token } = await mint(MEMBER.email);
    const res = await handleInviteAccept(post(token), database, MEMBER, token, linkSpy().deps);
    expect(res.status).toBe(200);
    expect((await readJson(res)).workspaceId).toBe(ws.id);
    expect((await getWorkspace(database, ws.id, MEMBER.id))?.id).toBe(ws.id);

    // single-use: the consumed token cannot be accepted again
    const again = await handleInviteAccept(post(token), database, MEMBER, token, linkSpy().deps);
    expect(again.status).toBe(410);
  });

  test('POST with a signed-in NON-matching session is rejected and grants nothing', async () => {
    const { ws, token } = await mint('someoneelse@example.com');
    const res = await handleInviteAccept(post(token), database, STRANGER, token, linkSpy().deps);
    expect(res.status).toBe(403);
    expect(await getWorkspace(database, ws.id, STRANGER.id)).toBeNull();
  });

  test('POST with no session re-sends the link to the BOUND address, creates nothing, and does not consume', async () => {
    const { ws, token } = await mint('fresh@example.com');
    const before = await db.select().from(schema.user);
    const spy = linkSpy();

    const res = await handleInviteAccept(post(token), database, null, token, spy.deps);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ sent: true });
    expect(spy.sent).toEqual([{ email: 'fresh@example.com', callbackURL: `/invite/${token}` }]);
    // No account, no membership, and the invitation is still pending — a session is
    // the only thing that can consume it, and only the emailed link grants one.
    expect(await db.select().from(schema.user)).toHaveLength(before.length);
    expect(await listPendingInvitations(database, ws.id, Date.now())).toHaveLength(1);
  });

  test('a no-session POST cannot be steered at another address — the binding decides, not the body', async () => {
    const { token } = await mint('bound@example.com');
    const spy = linkSpy();

    await handleInviteAccept(
      new Request(`https://x/invite/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'attacker@example.com', name: 'Nope' }),
      }),
      database,
      null,
      token,
      spy.deps,
    );

    expect(spy.sent).toEqual([{ email: 'bound@example.com', callbackURL: `/invite/${token}` }]);
  });
});
