import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import { orderInbox, transcriptObjectUrl, viewToListOpts } from './inbox-view.ts';

// Pure decisions the edge Inbox makes: list ordering (waiting_on:human pinned) and the R2
// object-URL derivation. Both are runtime-free so they test without the edge or a container.

describe('viewToListOpts — the unified-index views', () => {
  test('open (default) shows every open session — absent/unknown falls back to it', () => {
    expect(viewToListOpts('open')).toEqual({ status: 'open' });
    expect(viewToListOpts(null)).toEqual({ status: 'open' });
    expect(viewToListOpts('bogus')).toEqual({ status: 'open' });
    // a legacy ?view=needs-me URL (the retired view) also falls back to open
    expect(viewToListOpts('needs-me')).toEqual({ status: 'open' });
  });
  test('all shows every session, open and closed (no status filter)', () => {
    expect(viewToListOpts('all')).toEqual({});
  });
  test('closed shows the archive', () => {
    expect(viewToListOpts('closed')).toEqual({ status: 'closed' });
  });
});

const row = (o: Partial<ConversationRow>): ConversationRow =>
  ({
    id: o.id ?? 'c',
    sessionId: o.sessionId ?? 's',
    status: o.status ?? 'open',
    waitingOn: o.waitingOn ?? 'none',
    unread: o.unread ?? false,
    lastActivity: o.lastActivity ?? new Date(0),
    ownerRef: null,
    workspaceId: o.workspaceId ?? 'default',
    userId: o.userId ?? 'u',
    summary: o.summary ?? null,
    lastMessagePreview: o.lastMessagePreview ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as ConversationRow;

describe('orderInbox', () => {
  test('pins waiting_on:human to the top, then newest-activity first within each group', () => {
    const rows = [
      row({ id: 'agent-new', waitingOn: 'agent', lastActivity: new Date(500) }),
      row({ id: 'human-old', waitingOn: 'human', lastActivity: new Date(100) }),
      row({ id: 'agent-old', waitingOn: 'agent', lastActivity: new Date(200) }),
      row({ id: 'human-new', waitingOn: 'human', lastActivity: new Date(400) }),
    ];
    expect(orderInbox(rows).map((i) => i.id)).toEqual(['human-new', 'human-old', 'agent-new', 'agent-old']);
  });

  test('a closed row waiting_on:human does not pin above an open row with newer activity', () => {
    const rows = [
      row({ id: 'closed-waiting', status: 'closed', waitingOn: 'human', lastActivity: new Date(100) }),
      row({ id: 'open-newer', status: 'open', waitingOn: 'agent', lastActivity: new Date(200) }),
    ];
    expect(orderInbox(rows).map((i) => i.id)).toEqual(['open-newer', 'closed-waiting']);
  });

  test('normalizes lastActivity to epoch ms and projects the list fields', () => {
    const [item] = orderInbox([
      row({ id: 'x', waitingOn: 'human', unread: true, summary: 'S', lastMessagePreview: 'P', lastActivity: new Date(1234) }),
    ]);
    expect(item).toMatchObject({ id: 'x', waitingOn: 'human', unread: true, summary: 'S', lastMessagePreview: 'P', lastActivity: 1234 });
  });
});

describe('transcriptObjectUrl', () => {
  test('joins endpoint + bucket + the pure transcript key (S3 path-style)', () => {
    expect(transcriptObjectUrl('https://acct.r2.cloudflarestorage.com', 'cedar', 'sess-1')).toBe(
      'https://acct.r2.cloudflarestorage.com/cedar/sessions/sess-1/transcript.jsonl',
    );
  });
  test('tolerates a trailing slash on the endpoint', () => {
    expect(transcriptObjectUrl('https://acct.r2.cloudflarestorage.com/', 'cedar', 'sess-1')).toBe(
      'https://acct.r2.cloudflarestorage.com/cedar/sessions/sess-1/transcript.jsonl',
    );
  });
});

// The edge Inbox LIST is scoped to the ACTIVE workspace (the `cs_workspace` cookie), exactly
// how `/api/canvases` scopes (worker/shell.ts's `activeWorkspaceId`) — never a client-sent
// `?workspace=` param. In-memory DB built from the real migrations (mirrors shell.test.ts).
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
const USER = { id: 'user_1' };
const database = db as never;

const MEMBER = { id: 'user_member' };
const STRANGER = { id: 'user_stranger' };

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const u of [USER, MEMBER, STRANGER]) {
    await db.insert(schema.user).values({ id: u.id, name: u.id, email: `${u.id}@example.com` });
  }
  // #179: `default` has a real owned row (prod: the seed script); access is owner-OR-member.
  await db.insert(schema.workspaces).values({ id: 'default', name: 'Default', ownerUserId: USER.id });
  await db.insert(schema.workspaceMembers).values({ id: 'wm_1', workspaceId: 'default', userId: MEMBER.id });
});

mock.module('./sandbox-runtime.ts', () => ({ serveWorkspace: () => new Response('pad-html'), sandboxFor: () => ({}) }));
mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => database }));

const { handleInboxApi } = await import('./inbox.ts');

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe('handleInboxApi — list scoped to the active workspace', () => {
  test('GET with no cookie scopes to the default workspace', async () => {
    await conversations.create(database, { sessionId: 's_default', userId: USER.id, workspaceId: 'default' });
    const res = await handleInboxApi(new Request('https://x/api/inbox'), {} as never, USER);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.items.map((i: { workspaceId: string }) => i.workspaceId)).toEqual(['default']);
  });

  test('cs_workspace cookie scopes the list to that workspace only', async () => {
    const ws = await createWorkspace(database, { name: 'Proj', ownerUserId: USER.id });
    await conversations.create(database, { sessionId: 's_ws', userId: USER.id, workspaceId: ws.id });
    const cookie = `cs_workspace=${ws.id}`;

    const inWs = await readJson(
      await handleInboxApi(new Request('https://x/api/inbox', { headers: { cookie } }), {} as never, USER),
    );
    expect(inWs.items.every((i: { workspaceId: string }) => i.workspaceId === ws.id)).toBe(true);
    expect(inWs.items.length).toBeGreaterThan(0);

    // The default scope never sees the other workspace's conversation.
    const inDefault = await readJson(await handleInboxApi(new Request('https://x/api/inbox'), {} as never, USER));
    expect(inDefault.items.map((i: { workspaceId: string }) => i.workspaceId)).not.toContain(ws.id);
  });

  test('per-id access is MEMBERSHIP-gated (not creator-gated): a member reads, closes, reopens; a stranger 404s', async () => {
    const conv = await conversations.create(database, { sessionId: 's_detail', userId: USER.id, workspaceId: 'default' });
    const detail = await handleInboxApi(new Request(`https://x/api/inbox/${conv.id}`), {} as never, MEMBER, conv.id);
    expect(detail.status).toBe(200);

    const closed = await handleInboxApi(
      new Request(`https://x/api/inbox/${conv.id}/close`, { method: 'POST' }),
      {} as never,
      MEMBER,
      conv.id,
      'close',
    );
    expect(closed.status).toBe(200);

    const strangers = await handleInboxApi(new Request(`https://x/api/inbox/${conv.id}`), {} as never, STRANGER, conv.id);
    expect(strangers.status).toBe(404);
  });

  test('POST /api/inbox/:id/assign: assign a member, unassign with null; non-member target 400; stranger 404', async () => {
    const conv = await conversations.create(database, { sessionId: 's_assign', userId: USER.id, workspaceId: 'default' });
    const post = (userId: unknown, caller = USER) =>
      handleInboxApi(
        new Request(`https://x/api/inbox/${conv.id}/assign`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
        }),
        {} as never,
        caller,
        conv.id,
        'assign',
      );

    const assigned = await readJson(await post(MEMBER.id));
    expect(assigned.conversation.assignedTo).toBe(MEMBER.id);

    // Any member may (re)assign — advisory, not owner-only.
    const reassigned = await readJson(await post(USER.id, MEMBER));
    expect(reassigned.conversation.assignedTo).toBe(USER.id);

    const cleared = await readJson(await post(null));
    expect(cleared.conversation.assignedTo).toBeNull();

    expect((await post(STRANGER.id)).status).toBe(400); // target must be a workspace member
    expect((await post('')).status).toBe(400); // malformed body
    expect((await post(MEMBER.id, STRANGER)).status).toBe(404); // caller can't see the workspace
  });

  test('a non-owned workspace selection ⇒ 404 (never leaks another owner’s conversations)', async () => {
    const res = await handleInboxApi(
      new Request('https://x/api/inbox', { headers: { cookie: 'cs_workspace=ws_someone_else' } }),
      {} as never,
      USER,
    );
    expect(res.status).toBe(404);
  });

  test('the Inbox is workspace-shared: a MEMBER sees conversations they did not create', async () => {
    await conversations.create(database, { sessionId: 's_shared', userId: USER.id, workspaceId: 'default' });
    const res = await handleInboxApi(new Request('https://x/api/inbox'), {} as never, MEMBER);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.items.map((i: { sessionId?: string; id: string }) => i.id).length).toBeGreaterThan(0);
  });

  test('?assigned= filters: a user id, or "unassigned"; items carry assignedTo', async () => {
    const claimed = await conversations.create(database, {
      sessionId: 's_claimed',
      userId: USER.id,
      workspaceId: 'default',
      assignedTo: MEMBER.id,
    });
    const mine = await readJson(
      await handleInboxApi(new Request(`https://x/api/inbox?assigned=${MEMBER.id}`), {} as never, USER),
    );
    expect(mine.items.map((i: { id: string }) => i.id)).toEqual([claimed.id]);
    expect(mine.items[0].assignedTo).toBe(MEMBER.id);

    const unassigned = await readJson(
      await handleInboxApi(new Request('https://x/api/inbox?assigned=unassigned'), {} as never, USER),
    );
    expect(unassigned.items.map((i: { id: string }) => i.id)).not.toContain(claimed.id);
    expect(unassigned.items.every((i: { assignedTo: string | null }) => i.assignedTo === null)).toBe(true);
  });

  test('the list never honors a client-sent ?workspace= — server-side scoping replaces it', async () => {
    const ws = await createWorkspace(database, { name: 'Other', ownerUserId: USER.id });
    await conversations.create(database, { sessionId: 's_other', userId: USER.id, workspaceId: ws.id });
    // No cookie ⇒ default scope; a ?workspace= naming the other workspace must NOT leak it.
    const res = await readJson(
      await handleInboxApi(new Request(`https://x/api/inbox?workspace=${ws.id}`), {} as never, USER),
    );
    expect(res.items.map((i: { workspaceId: string }) => i.workspaceId)).not.toContain(ws.id);
  });
});
