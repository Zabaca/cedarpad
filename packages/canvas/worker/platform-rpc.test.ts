import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { conversations, makeDb } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import { PushPayload } from '../shared/push-contract.ts';
import {
  ComponentHistoryOutput,
  ComponentReadOutput,
  ComponentWriteOutput,
  ConversationStartOutput,
  PLATFORM_RPC_PATH,
  TurnEndOutput,
  platformRpcToken,
} from '../shared/platform-rpc.ts';
import { handlePlatformRpc } from './platform-rpc.ts';
import { d1RecordStore } from './record-store.ts';
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

// CONTEXT.md "Open PR": a dev-agent run that calls `open_pr` reports the PR it opened back
// here, and THAT is what makes the Inbox's Merge action appear. The container never writes
// the row (ADR-0018) — it names the chat, exactly as every other operation does.
describe('platform RPC: conversation.prOpened', () => {
  test('stamps the PR the run opened onto the chat‘s row', async () => {
    const db = await freshDb();
    const input = { sessionId: 's-pr', userId: 'u', workspaceId: 'w', ownerRef: 'chat_PR', kind: 'dev-agent' as const };
    await rpc({ op: 'conversation.start', input }, { db });

    const res = await rpc(
      { op: 'conversation.prOpened', input: { ...input, prUrl: 'https://github.com/Zabaca/cedarpad/pull/283' } },
      { db },
    );

    expect(res.status).toBe(200);
    const row = await conversations.getByOwnerRef(db, 'chat_PR');
    expect(row?.prUrl).toBe('https://github.com/Zabaca/cedarpad/pull/283');
    expect(row?.prMergedAt).toBeNull();
  });

  test('a second PR on the same chat replaces the first — the row names the LATEST open PR', async () => {
    const db = await freshDb();
    const input = { sessionId: 's-pr2', userId: 'u', workspaceId: 'w', ownerRef: 'chat_PR2', kind: 'dev-agent' as const };

    await rpc({ op: 'conversation.prOpened', input: { ...input, prUrl: 'https://github.com/o/r/pull/1' } }, { db });
    await rpc({ op: 'conversation.prOpened', input: { ...input, prUrl: 'https://github.com/o/r/pull/2' } }, { db });

    expect((await conversations.list(db)).length).toBe(1);
    expect((await conversations.getByOwnerRef(db, 'chat_PR2'))?.prUrl).toBe('https://github.com/o/r/pull/2');
  });

  test('a url that is not a GitHub pull request is refused at the boundary', async () => {
    const db = await freshDb();
    const res = await rpc(
      {
        op: 'conversation.prOpened',
        input: { sessionId: 's-x', userId: 'u', workspaceId: 'w', ownerRef: 'chat_X', prUrl: 'not-a-url' },
      },
      { db },
    );
    expect(res.status).toBe(400);
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

// --- Records (ADR-0022) ------------------------------------------------------------
// Component source crosses the container/edge boundary as a DOMAIN VERB, and the edge —
// not the container's payload — decides whether the write is allowed and well-formed.

/** A canvas registered to a workspace, so the ownership check has something real to check. */
const registerCanvas = async (db: Awaited<ReturnType<typeof freshDb>>, workspaceId: string) =>
  (await canvasRegistry.create(db, { workspaceId, name: 'Board' })).id;

describe('platform RPC: component.write / component.read', () => {
  test('a written Component is readable back as a Record', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');

    const written = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'KpiCard', source: 'export default () => null;' } },
      { db },
    );
    expect(written.status).toBe(200);
    expect(ComponentWriteOutput.parse(await written.json()).rev).toBe(1);

    const read = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, name: 'KpiCard' } }, { db });
    expect(read.status).toBe(200);
    expect(ComponentReadOutput.parse(await read.json()).source).toBe('export default () => null;');
  });

  test('reading a Component nobody wrote answers "absent", not an error', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const read = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, name: 'Ghost' } }, { db });
    expect(read.status).toBe(200);
    expect(ComponentReadOutput.parse(await read.json()).source).toBeNull();
  });

  test('the edge refuses a canvas that does not belong to the named workspace', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_owner');

    const res = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_intruder', canvasId, userId: 'u_1', name: 'Card', source: 'x' } },
      { db },
    );
    expect(res.status).toBe(403);
    // …and nothing was stored under the real owner either.
    const read = await rpc({ op: 'component.read', input: { workspaceId: 'ws_owner', canvasId, name: 'Card' } }, { db });
    expect(ComponentReadOutput.parse(await read.json()).source).toBeNull();
  });

  test('the edge refuses a canvas with no registry row at all', async () => {
    const db = await freshDb();
    const res = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId: 'cv_never_registered', userId: 'u_1', name: 'Card', source: 'x' } },
      { db },
    );
    expect(res.status).toBe(403);
  });

  test('the legacy default canvas is writable only under the legacy default workspace', async () => {
    const db = await freshDb();
    const ok = await rpc(
      { op: 'component.write', input: { workspaceId: 'default', canvasId: 'default', userId: 'u_1', name: 'Card', source: 'x' } },
      { db },
    );
    expect(ok.status).toBe(200);

    const nope = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_other', canvasId: 'default', userId: 'u_1', name: 'Card', source: 'x' } },
      { db },
    );
    expect(nope.status).toBe(403);
  });

  test('the edge validates the name itself — a traversing name never reaches the store', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: '../../../etc/passwd', source: 'x' } },
      { db },
    );
    expect(res.status).toBe(400);
  });

  test('the edge refuses a blank source rather than storing an empty Component', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Card', source: '   \n' } },
      { db },
    );
    expect(res.status).toBe(400);
  });

  test('a rewrite bumps the rev and history records who wrote each one', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v1' } }, { db });
    const second = await rpc({ op: 'component.write', input: { ...input, userId: 'u_2', source: 'v2' } }, { db });

    expect(ComponentWriteOutput.parse(await second.json()).rev).toBe(2);
    const versions = await d1RecordStore(db).listVersions({ workspaceId: 'ws_a', canvasId, name: 'Card' });
    expect(versions.map((v) => [v.version, v.source, v.createdBy])).toEqual([
      [2, 'v2', 'u_2'],
      [1, 'v1', 'u_1'],
    ]);
  });
});

describe('platform RPC: component.history', () => {
  test('a Component reports its versions newest first, each with its author', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v1' } }, { db });
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_2', source: 'v2' } }, { db });

    const res = await rpc({ op: 'component.history', input }, { db });
    expect(res.status).toBe(200);
    const { versions } = ComponentHistoryOutput.parse(await res.json());
    expect(versions.map((v) => [v.version, v.createdBy])).toEqual([
      [2, 'u_2'],
      [1, 'u_1'],
    ]);
    // The timestamp survives the hop as a real instant, not a string nobody can order.
    expect(versions[0]?.createdAt).toBeInstanceOf(Date);
  });

  test('the history omits the source — asking what happened must not cost the whole corpus', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'a very long component source' } }, { db });

    const body = await (await rpc({ op: 'component.history', input }, { db })).text();
    expect(body).not.toContain('a very long component source');
  });

  test('a Component nobody wrote has an empty history, not an error', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc({ op: 'component.history', input: { workspaceId: 'ws_a', canvasId, name: 'Ghost' } }, { db });
    expect(ComponentHistoryOutput.parse(await res.json()).versions).toEqual([]);
  });

  test('a write from a container with no identity is stored UNATTRIBUTED, not under a placeholder', async () => {
    // "We do not know who" is a real state. A history that names a placeholder no user query
    // will ever match looks attributed and is not — the failure mode this slice exists to close.
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    const written = await rpc({ op: 'component.write', input: { ...input, userId: null, source: 'v1' } }, { db });
    expect(written.status).toBe(200);

    const { versions } = ComponentHistoryOutput.parse(await (await rpc({ op: 'component.history', input }, { db })).json());
    expect(versions.map((v) => v.createdBy)).toEqual([null]);
  });

  test('the edge refuses a canvas that does not belong to the named workspace', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_owner');
    await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_owner', canvasId, userId: 'u_1', name: 'Card', source: 'v1' } },
      { db },
    );

    // History is a read of someone else's workspace unless the same ownership rule gates it.
    const res = await rpc({ op: 'component.history', input: { workspaceId: 'ws_intruder', canvasId, name: 'Card' } }, { db });
    expect(res.status).toBe(403);
  });
});
