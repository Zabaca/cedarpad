import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { conversations, makeDb } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import { PushPayload } from '../shared/push-contract.ts';
import { ConversationStartOutput, PLATFORM_RPC_PATH, TurnEndOutput, platformRpcToken } from '../shared/platform-rpc.ts';
import { handlePlatformRpc } from './platform-rpc.ts';
import type { PushSend } from './push-notify.ts';

// The platform RPC (ADR-0018): the container's ONLY way back into the platform data layer.
// Two named, behavioural operations — "find or create the conversation for this session" and
// "notify the members watching this conversation". No query, no exec, no table name: the
// rejected sqlite-proxy alternative is unrepresentable in this surface by construction.
//
// The edge half is exercised against a real in-memory platform data layer built from the
// Drizzle migrations (mirrors server/inbox.test.ts), so these are behaviour tests, not
// mock choreography — the only injected seam is the push transport.

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

const SECRET = 'better-auth-test-secret';

const rpc = async (
  body: unknown,
  opts: { db: Awaited<ReturnType<typeof freshDb>>; token?: string | null; send?: PushSend | null },
): Promise<Response> =>
  handlePlatformRpc(
    new Request(`https://app.cedarpad.com${PLATFORM_RPC_PATH}`, {
      method: 'POST',
      headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? (await platformRpcToken(SECRET))}` },
      body: JSON.stringify(body),
    }),
    { BETTER_AUTH_SECRET: SECRET } as never,
    { db: opts.db, send: opts.send ?? null, origin: 'https://app.cedarpad.com' },
  );

describe('platform RPC: the edge authenticates the caller', () => {
  test('an unauthenticated request cannot invoke an operation', async () => {
    const db = await freshDb();
    const res = await rpc(
      { op: 'conversation.start', input: { sessionId: 's-1', userId: 'u', workspaceId: 'w' } },
      { db, token: null },
    );
    expect(res.status).toBe(401);
  });
});

describe('platform RPC: conversation.start', () => {
  test('files the Conversation for the session, and repeats reuse the same row', async () => {
    const db = await freshDb();
    const input = { sessionId: 's-1', userId: 'u', workspaceId: 'w', ownerRef: 'chat_A', summary: 'first message' };

    const first = await rpc({ op: 'conversation.start', input }, { db });
    expect(first.status).toBe(200);
    const { conversationId } = ConversationStartOutput.parse(await first.json());

    const again = await rpc({ op: 'conversation.start', input: { ...input, sessionId: 's-2' } }, { db });
    expect(ConversationStartOutput.parse(await again.json()).conversationId).toBe(conversationId);

    const row = await conversations.get(db, conversationId);
    expect(row?.summary).toBe('first message');
    // The chat is the identity; the newest session is re-pointed onto the one row.
    expect(row?.sessionId).toBe('s-2');
  });
});

// #266: the container has no database at all now, so the settle-time backstop and the
// end_turn transition are RPC operations too.
describe('platform RPC: conversation.settle', () => {
  test('files the row when the start never landed, and marks it active', async () => {
    const db = await freshDb();

    const res = await rpc(
      {
        op: 'conversation.settle',
        input: { sessionId: 's-settle', userId: 'u', workspaceId: 'w', ownerRef: 'chat_S', summary: 'a turn that settled' },
      },
      { db },
    );

    expect(res.status).toBe(200);
    const row = await conversations.getByOwnerRef(db, 'chat_S');
    expect(row?.summary).toBe('a turn that settled');
    expect(row?.unread).toBe(true); // markActivity: it shows in "All"
  });

  test('a settle after a start touches the SAME row — never a second one for the chat', async () => {
    const db = await freshDb();
    const input = { sessionId: 's-1', userId: 'u', workspaceId: 'w', ownerRef: 'chat_S2', summary: 'first message' };

    const started = ConversationStartOutput.parse(
      await (await rpc({ op: 'conversation.start', input }, { db })).json(),
    );
    await rpc({ op: 'conversation.settle', input }, { db });

    expect((await conversations.list(db)).map((r) => r.id)).toEqual([started.conversationId]);
  });
});

describe('platform RPC: turn.end', () => {
  test('done: the work is complete — waiting_on none, the summary is the preview', async () => {
    const db = await freshDb();

    const res = await rpc(
      {
        op: 'turn.end',
        input: { sessionId: 's-d', userId: 'u', workspaceId: 'w', ownerRef: 'chat_D', summary: 'shipped it', outcome: 'done' },
      },
      { db },
    );

    expect(res.status).toBe(200);
    const { conversationId } = TurnEndOutput.parse(await res.json());
    const row = await conversations.get(db, conversationId);
    expect(row?.waitingOn).toBe('none');
    expect(row?.lastMessagePreview).toBe('shipped it');
  });

  test('needs_human: the Conversation is promoted with the question as the preview', async () => {
    const db = await freshDb();

    const res = await rpc(
      {
        op: 'turn.end',
        input: {
          sessionId: 's-h',
          userId: 'u',
          workspaceId: 'w',
          ownerRef: 'chat_H',
          summary: 'blocked on a product call',
          outcome: 'needs_human',
          question: 'which branch?',
        },
      },
      { db },
    );

    const { conversationId } = TurnEndOutput.parse(await res.json());
    const row = await conversations.get(db, conversationId);
    expect(row?.waitingOn).toBe('human');
    expect(row?.status).toBe('open');
    expect(row?.unread).toBe(true);
    expect(row?.lastMessagePreview).toBe('which branch?');
  });

  test('the id it returns is the handle the container then asks `notify` for — one row, both ops', async () => {
    const db = await freshDb();
    const { conversationId } = TurnEndOutput.parse(
      await (
        await rpc(
          {
            op: 'turn.end',
            input: { sessionId: 's-x', userId: 'u', workspaceId: 'w', ownerRef: 'chat_X', summary: 's', outcome: 'needs_human', question: 'q' },
          },
          { db },
        )
      ).json(),
    );

    const notified = await rpc({ op: 'notify', input: { conversationId, question: 'q' } }, { db });
    expect(notified.status).toBe(200); // resolvable: the handle names a real row
  });
});

describe('platform RPC: notify', () => {
  test('pings every device subscribed by the members the Conversation should wake', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'u_owner', {
      endpoint: 'https://fcm.example/owner',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const conv = await findOrCreateConversation(db, {
      sessionId: 's-n',
      userId: 'u_owner',
      workspaceId: 'w',
      ownerRef: 'chat_N',
      summary: 'needs a human',
      assignTo: 'u_owner',
    });

    const sent: Array<{ endpoint: string; payload: string }> = [];
    const res = await rpc(
      { op: 'notify', input: { conversationId: conv.id, question: 'which branch?' } },
      {
        db,
        send: async (sub, payload) => {
          sent.push({ endpoint: sub.endpoint, payload });
          return 'delivered';
        },
      },
    );

    expect(res.status).toBe(200);
    expect(sent.map((s) => s.endpoint)).toEqual(['https://fcm.example/owner']);
    const payload = PushPayload.parse(JSON.parse(sent[0]!.payload));
    expect(payload.body).toBe('which branch?');
    expect(payload.conversationId).toBe(conv.id);
  });
});
