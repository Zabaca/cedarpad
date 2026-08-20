import { migrationStatements } from './migration-statements.ts';
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import { orderInbox, transcriptObjectUrl, unseenCount, viewToListOpts } from './inbox-view.ts';
import { workspaceEventsName } from '../shared/workspace-events.ts';

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
    ownerRef: o.ownerRef ?? null,
    kind: o.kind ?? 'chat',
    repo: o.repo ?? null,
    prUrl: o.prUrl ?? null,
    prMergedAt: o.prMergedAt ?? null,
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

  test('projects ownerRef (the draft-chat match key for the Shell)', () => {
    const [item] = orderInbox([row({ id: 'x', ownerRef: 'chat_abc' })]);
    expect(item?.ownerRef).toBe('chat_abc');
  });

  // The Conversation's PR state (CONTEXT.md "Open PR"): what the Inbox renders its Merge
  // action from. A row that never opened a PR carries neither field.
  test('projects the open PR a dev-agent run left on the row', () => {
    const [item] = orderInbox([
      row({ id: 'x', kind: 'dev-agent', repo: 'Zabaca/cedarpad', prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' }),
    ]);
    expect(item).toMatchObject({
      kind: 'dev-agent',
      repo: 'Zabaca/cedarpad',
      prUrl: 'https://github.com/Zabaca/cedarpad/pull/283',
      prMergedAt: null,
    });
  });

  test('projects the merge stamp once the PR has landed', () => {
    const [item] = orderInbox([
      row({ id: 'x', kind: 'dev-agent', prUrl: 'https://github.com/Zabaca/cedarpad/pull/283', prMergedAt: new Date(9000) }),
    ]);
    expect(item?.prMergedAt).toBe(9000);
  });

  test('an ordinary chat carries no PR state', () => {
    const [item] = orderInbox([row({ id: 'x' })]);
    expect(item).toMatchObject({ prUrl: null, prMergedAt: null });
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

// #248: index.ts now imports warehouseExec from here (moved from an inline definition) —
// this file's full-module mock must supply it too, unused by these tests.
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: () => new Response('pad-html'),
  sandboxFor: () => ({}),
  warehouseExec: async () => ({ success: true, stdout: '', stderr: '' }),
}));
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

// ADR-0016: the list drops rows hidden from the caller — the chat's own private flag, or
// a private linked canvas (canvas dominates, its chats' creators included). Per-id actions
// 404 on hidden rows; the chat's own flag flips via /visibility, creator-only.
describe('handleInboxApi — visibility (ADR-0016)', () => {
  let wsId = '';
  let cookie = '';
  const listFor = async (user: { id: string }) =>
    readJson(await handleInboxApi(new Request('https://x/api/inbox?view=all', { headers: { cookie } }), {} as never, user));

  beforeAll(async () => {
    const ws = await createWorkspace(database, { name: 'VisWs', ownerUserId: USER.id });
    wsId = ws.id;
    cookie = `cs_workspace=${wsId}`;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_vis_inbox', workspaceId: wsId, userId: MEMBER.id });
  });

  test('a private chat lists for its creator only; the response carries me', async () => {
    const conv = await conversations.create(database, {
      sessionId: 's_vis1',
      userId: 'system',
      workspaceId: wsId,
      createdBy: USER.id,
    });
    await conversations.setVisibility(database, conv.id, 'private');
    const mine = await listFor(USER);
    expect(mine.me).toBe(USER.id);
    expect(mine.items.map((i: { id: string }) => i.id)).toContain(conv.id);
    const theirs = await listFor(MEMBER);
    expect(theirs.items.map((i: { id: string }) => i.id)).not.toContain(conv.id);
    // Per-id: hidden ⇒ the same 404 as missing.
    const detail = await handleInboxApi(new Request(`https://x/api/inbox/${conv.id}`), {} as never, MEMBER, conv.id);
    expect(detail.status).toBe(404);
  });

  test('canvas dominates: a shared chat on a private canvas hides even from the CHAT creator', async () => {
    const canvas = await canvasRegistry.create(database, { workspaceId: wsId, name: 'Secret', createdBy: MEMBER.id });
    await canvasRegistry.setVisibility(database, canvas.id, 'private');
    const conv = await conversations.create(database, {
      sessionId: 's_vis2',
      userId: 'system',
      workspaceId: wsId,
      canvasId: canvas.id,
      createdBy: USER.id,
    });
    expect((await listFor(USER)).items.map((i: { id: string }) => i.id)).not.toContain(conv.id);
    // The canvas creator still sees it.
    expect((await listFor(MEMBER)).items.map((i: { id: string }) => i.id)).toContain(conv.id);
  });

  test('POST /visibility is creator-only', async () => {
    const conv = await conversations.create(database, {
      sessionId: 's_vis3',
      userId: 'system',
      workspaceId: wsId,
      createdBy: USER.id,
    });
    const flip = (user: { id: string }, visibility: string) =>
      handleInboxApi(
        new Request(`https://x/api/inbox/${conv.id}/visibility`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visibility }),
        }),
        {} as never,
        user,
        conv.id,
        'visibility',
      );
    expect((await flip(MEMBER, 'private')).status).toBe(403);
    const ok = await flip(USER, 'private');
    expect(ok.status).toBe(200);
    expect(((await readJson(ok)) as { conversation: { visibility: string } }).conversation.visibility).toBe('private');
  });
});

describe('handleInboxApi — shared read mark + badge stream (read-for-all)', () => {
  test('unseenCount: open items newer than the mark; closed and already-seen excluded', () => {
    const items = orderInbox([
      row({ id: 'new-open', lastActivity: new Date(500) }),
      row({ id: 'old-open', lastActivity: new Date(100) }),
      row({ id: 'new-closed', status: 'closed', lastActivity: new Date(600) }),
    ]);
    expect(unseenCount(items, 200)).toBe(1);
    expect(unseenCount(items, 0)).toBe(2); // never read: everything open counts
  });

  test('POST /api/inbox/read stamps the workspace mark; the list echoes it for every member', async () => {
    const ws = await createWorkspace(database, { name: 'Badge', ownerUserId: USER.id });
    await db.insert(schema.workspaceMembers).values({ id: 'wm_badge', workspaceId: ws.id, userId: MEMBER.id });
    const cookie = `cs_workspace=${ws.id}`;
    const before = await readJson(await handleInboxApi(new Request('https://x/api/inbox', { headers: { cookie } }), {} as never, USER));
    expect(before.readAt).toBe(0);

    const stamped = await readJson(
      await handleInboxApi(new Request('https://x/api/inbox/read', { method: 'POST', headers: { cookie } }), {} as never, USER, 'read'),
    );
    expect(stamped.readAt).toBeGreaterThan(0);

    // Read-for-all: the OTHER member's list carries the same mark.
    const after = await readJson(await handleInboxApi(new Request('https://x/api/inbox', { headers: { cookie } }), {} as never, MEMBER));
    expect(after.readAt).toBe(stamped.readAt);
  });

  test('GET /api/inbox/events streams the badge count as an SSE frame', async () => {
    const ws = await createWorkspace(database, { name: 'Stream', ownerUserId: USER.id });
    await conversations.create(database, { sessionId: 's_stream', userId: USER.id, workspaceId: ws.id });
    const cookie = `cs_workspace=${ws.id}`;
    const res = await handleInboxApi(new Request('https://x/api/inbox/events', { headers: { cookie } }), {} as never, USER, 'events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain('"count":1'); // one open conversation, never read
    await reader.cancel();
  });
});

// Every EDGE writer of the conversation and inbox-read tables rings the workspace's events
// hub (#383). This is the half the issue warns about: the container's writes all funnel
// through `handlePlatformRpc`, so it is easy to wire that one handler and ship a badge that
// updates for agent activity and not for human actions — which looks fixed and is worse
// than the polling it replaced. Each route below is a human action.
describe('handleInboxApi — every mutation rings the workspace events hub', () => {
  const recorder = () => {
    const rung: string[] = [];
    const env = {
      WORKSPACE_EVENTS: {
        idFromName: (name: string) => ({ name }),
        get: ({ name }: { name: string }) => ({
          fetch: async () => {
            rung.push(name);
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as never;
    return { rung, env };
  };

  const conv = async (workspaceId = 'default') =>
    conversations.create(database, {
      sessionId: `s_hub_${Math.random().toString(36).slice(2)}`,
      userId: USER.id,
      workspaceId,
      createdBy: USER.id,
    });

  const post = (env: never, path: string, id: string | undefined, action: string | undefined, body?: unknown) =>
    handleInboxApi(
      new Request(`https://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      USER,
      id,
      action,
    );

  test('POST /api/inbox/read — the shared read mark clears every member’s badge', async () => {
    const { rung, env } = recorder();
    await post(env, '/api/inbox/read', 'read', undefined);
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  test('POST /api/inbox/:id/close and /reopen — the two status transitions', async () => {
    const row = await conv();
    const { rung, env } = recorder();
    await post(env, `/api/inbox/${row.id}/close`, row.id, 'close');
    await post(env, `/api/inbox/${row.id}/reopen`, row.id, 'reopen');
    expect(rung).toEqual([workspaceEventsName('default'), workspaceEventsName('default')]);
  });

  test('POST /api/inbox/:id/assign — a triage claim', async () => {
    const row = await conv();
    const { rung, env } = recorder();
    await post(env, `/api/inbox/${row.id}/assign`, row.id, 'assign', { userId: MEMBER.id });
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  test('POST /api/inbox/:id/visibility — the flip that changes who counts it', async () => {
    const row = await conv();
    const { rung, env } = recorder();
    await post(env, `/api/inbox/${row.id}/visibility`, row.id, 'visibility', { visibility: 'private' });
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  test('POST /api/inbox/:id/merge — landing the PR closes the run', async () => {
    const row = await conv();
    await conversations.recordPr(database, row.id, 'https://github.com/Zabaca/cedarpad/pull/9');
    const { rung, env } = recorder();
    const res = await handleInboxApi(
      new Request(`https://x/api/inbox/${row.id}/merge`, { method: 'POST' }),
      env,
      USER,
      row.id,
      'merge',
      {
        resolveRepo: async () => ({ repoFullName: 'Zabaca/cedarpad', auth: { kind: 'installation', installationId: '42' } }),
        mint: async () => 'ghs_minted',
        merge: async () => ({ ok: true }),
      } as never,
    );
    expect(res.status).toBe(200);
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  // The hub is addressed by the CONVERSATION's workspace, not by the caller's active one.
  // They differ whenever a member acts on a row from another workspace's inbox view, and
  // ringing the wrong hub is a notification nobody receives.
  test('the hub rung is the conversation’s own workspace, not the cookie’s', async () => {
    const ws = await createWorkspace(database, { name: 'Elsewhere', ownerUserId: USER.id });
    const row = await conv(ws.id);
    const { rung, env } = recorder();
    await post(env, `/api/inbox/${row.id}/close`, row.id, 'close');
    expect(rung).toEqual([workspaceEventsName(ws.id)]);
  });

  test('a REFUSED mutation rings nothing — there was no change to announce', async () => {
    const row = await conv();
    const { rung, env } = recorder();
    // Creator-only: a non-creator's visibility flip is a 403 and writes no row.
    const res = await handleInboxApi(
      new Request(`https://x/api/inbox/${row.id}/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
      env,
      MEMBER,
      row.id,
      'visibility',
    );
    expect(res.status).toBe(403);
    expect(rung).toEqual([]);
  });

  test('a hub that is unreachable never breaks the write it was announcing', async () => {
    const row = await conv();
    const broken = {
      WORKSPACE_EVENTS: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async () => {
            throw new Error('hub down');
          },
        }),
      },
    } as never;
    const res = await post(broken, `/api/inbox/${row.id}/close`, row.id, 'close');
    expect(res.status).toBe(200);
    expect((await conversations.get(database, row.id))?.status).toBe('closed');
  });
});

// The Inbox merge (CONTEXT.md "Open PR"): landing a dev-agent run's PR without leaving the
// Inbox. Merging is an EDGE act — the App private key never leaves the edge (ADR-0008) — so
// the two outward-facing pieces (minting the repo-scoped token, calling GitHub) are the
// injected seams; everything else is real.
describe('handleInboxApi — POST /api/inbox/:id/merge', () => {
  const devAgentConv = async (over: Partial<{ prUrl: string; repo: string; kind: 'chat' | 'dev-agent' }> = {}) => {
    const conv = await conversations.create(database, {
      sessionId: `s_merge_${Math.random().toString(36).slice(2)}`,
      userId: USER.id,
      workspaceId: 'default',
      kind: over.kind ?? 'dev-agent',
      repo: over.repo ?? 'Zabaca/cedarpad',
    });
    if (over.prUrl !== undefined) await conversations.recordPr(database, conv.id, over.prUrl);
    return conv;
  };

  const merge = (
    convId: string,
    seams: Partial<Parameters<typeof handleInboxApi>[5]> = {},
    caller: { id: string } = USER,
  ) =>
    handleInboxApi(
      new Request(`https://x/api/inbox/${convId}/merge`, { method: 'POST' }),
      {} as never,
      caller as never,
      convId,
      'merge',
      {
        resolveRepo: async () => ({ repoFullName: 'Zabaca/cedarpad', auth: { kind: 'installation', installationId: '42' } }),
        mint: async () => 'ghs_minted',
        merge: async () => ({ ok: true }),
        ...seams,
      } as never,
    );

  test('merges the recorded PR with a token scoped to the conversation‘s own repo, then stamps and closes the row', async () => {
    const conv = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' });
    const merged: Array<{ prUrl: string; token: string }> = [];
    const mintedFor: string[] = [];

    const res = await merge(conv.id, {
      mint: (async (_env: unknown, o: { repoFullName: string }) => {
        mintedFor.push(o.repoFullName);
        return 'ghs_minted';
      }) as never,
      merge: (async (o: { prUrl: string; token: string }) => {
        merged.push(o);
        return { ok: true };
      }) as never,
    });

    expect(res.status).toBe(200);
    expect(mintedFor).toEqual(['Zabaca/cedarpad']);
    expect(merged).toEqual([{ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283', token: 'ghs_minted' }]);

    const row = await conversations.get(database, conv.id);
    expect(row?.prMergedAt).not.toBeNull();
    expect(row?.status).toBe('closed'); // landing the PR is what ends the run
  });

  test('a conversation with no recorded PR has nothing to merge — 409, and GitHub is never called', async () => {
    const conv = await devAgentConv();
    const calls: unknown[] = [];

    const res = await merge(conv.id, { merge: (async (o: unknown) => (calls.push(o), { ok: true })) as never });

    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test('an already-merged PR cannot be merged twice — 409, and GitHub is never called', async () => {
    const conv = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' });
    await conversations.markPrMerged(database, conv.id);
    const calls: unknown[] = [];

    const res = await merge(conv.id, { merge: (async (o: unknown) => (calls.push(o), { ok: true })) as never });

    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test('GitHub‘s refusal reaches the caller verbatim and the row keeps its open PR', async () => {
    const conv = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' });

    const res = await merge(conv.id, {
      merge: (async () => ({ ok: false, alreadyMerged: false, reason: 'Pull Request is not mergeable' })) as never,
    });

    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe('Pull Request is not mergeable');
    const row = await conversations.get(database, conv.id);
    expect(row?.prMergedAt).toBeNull();
    expect(row?.status).toBe('open'); // retry after CI goes green is one click
  });

  test('a PR GitHub reports as ALREADY merged is recorded as merged — the row was stale, not wrong', async () => {
    const conv = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' });

    const res = await merge(conv.id, {
      merge: (async () => ({ ok: false, alreadyMerged: true, reason: 'already merged' })) as never,
    });

    expect(res.status).toBe(200);
    const row = await conversations.get(database, conv.id);
    expect(row?.prMergedAt).not.toBeNull();
    expect(row?.status).toBe('closed');
  });

  test('any workspace MEMBER may merge; a stranger gets the same 404 as a missing row', async () => {
    const forMember = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/1' });
    expect((await merge(forMember.id, {}, MEMBER)).status).toBe(200);

    const forStranger = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/2' });
    expect((await merge(forStranger.id, {}, STRANGER)).status).toBe(404);
  });

  test('no repo credential resolves ⇒ 502, never a merge attempted token-less', async () => {
    const conv = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' });
    const calls: unknown[] = [];

    const res = await merge(conv.id, {
      mint: (async () => null) as never,
      merge: (async (o: unknown) => (calls.push(o), { ok: true })) as never,
    });

    expect(res.status).toBe(502);
    expect(calls).toEqual([]);
  });

  test('only POST', async () => {
    const conv = await devAgentConv({ prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' });
    const res = await handleInboxApi(new Request(`https://x/api/inbox/${conv.id}/merge`), {} as never, USER, conv.id, 'merge');
    expect(res.status).toBe(405);
  });
});
