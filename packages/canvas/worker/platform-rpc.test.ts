import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { conversations, makeDb } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import { PushPayload } from '../shared/push-contract.ts';
import { ConversationStartOutput, PLATFORM_RPC_PATH, platformRpcToken } from '../shared/platform-rpc.ts';
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
