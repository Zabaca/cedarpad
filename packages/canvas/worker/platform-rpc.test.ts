import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { conversations, makeDb } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { user } from '../web-poc/lib/db/schema.ts';
import { DATA_MAX_BYTES } from '../shared/bridge-wire.ts';
import { PushPayload } from '../shared/push-contract.ts';
import {
  ComponentHistoryOutput,
  ComponentListOutput,
  ComponentReadOutput,
  ComponentRestoreOutput,
  ComponentWriteOutput,
  ConversationStartOutput,
  DataReadOutput,
  DataWriteOutput,
  PLATFORM_RPC_PATH,
  SkillListOutput,
  SkillWriteOutput,
  TurnEndOutput,
  platformRpcToken,
} from '../shared/platform-rpc.ts';
import { handlePlatformRpc } from './platform-rpc.ts';
import { d1RecordStore } from './record-store.ts';
import { d1SkillFileStore } from './skill-file-store.ts';
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
  opts: {
    db: Awaited<ReturnType<typeof freshDb>>;
    token?: string | null;
    send?: PushSend | null;
    notify?: (workspaceId: string) => Promise<void>;
  },
): Promise<Response> =>
  handlePlatformRpc(
    new Request(`https://app.cedarpad.com${PLATFORM_RPC_PATH}`, {
      method: 'POST',
      headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? (await platformRpcToken(SECRET))}` },
      body: JSON.stringify(body),
    }),
    { BETTER_AUTH_SECRET: SECRET } as never,
    { db: opts.db, send: opts.send ?? null, origin: 'https://app.cedarpad.com', notify: opts.notify ?? (async () => {}) },
  );

// #383: the container's writes all arrive here, so this is the one handler that covers the
// whole agent-side path. Every operation that touches a Conversation row rings the hub.
describe('platform RPC: conversation writes ring the workspace events hub', () => {
  const identity = { sessionId: 's-hub', userId: 'u', workspaceId: 'ws_agent', ownerRef: 'chat_hub' };
  const ops: [string, unknown][] = [
    ['conversation.start', { op: 'conversation.start', input: identity }],
    ['conversation.settle', { op: 'conversation.settle', input: identity }],
    ['conversation.prOpened', { op: 'conversation.prOpened', input: { ...identity, prUrl: 'https://github.com/o/r/pull/1' } }],
    ['turn.end (done)', { op: 'turn.end', input: { ...identity, outcome: 'done', summary: 'finished' } }],
    ['turn.end (needs_human)', { op: 'turn.end', input: { ...identity, outcome: 'needs_human', summary: 's', question: 'q?' } }],
  ];

  for (const [name, body] of ops) {
    test(`${name} rings the conversation's workspace`, async () => {
      const db = await freshDb();
      const rung: string[] = [];
      const res = await rpc(body, { db, notify: async (ws) => void rung.push(ws) });
      expect(res.status).toBe(200);
      expect(rung).toEqual(['ws_agent']);
    });
  }

  test('an operation that touches no Conversation rings nothing', async () => {
    const db = await freshDb();
    const rung: string[] = [];
    await rpc(
      { op: 'component.read', input: { workspaceId: 'default', canvasId: 'default', tier: 'own', name: 'Thing' } },
      { db, notify: async (ws) => void rung.push(ws) },
    );
    expect(rung).toEqual([]);
  });

  test('a hub that throws never fails the operation the container is waiting on', async () => {
    const db = await freshDb();
    const res = await rpc(
      { op: 'turn.end', input: { ...identity, outcome: 'done', summary: 'finished' } },
      {
        db,
        notify: async () => {
          throw new Error('hub down');
        },
      },
    );
    expect(res.status).toBe(200);
  });
});

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

  // The SHARED tier has no canvas of its own, so the ownership check above has nothing to
  // look up — and "no canvas to check" must never quietly mean "no check". A shared-tier
  // operation therefore names the canvas it is acting FROM, that canvas is checked exactly
  // as an own-tier write is, and the null canvas key is minted at the EDGE. The container
  // never sends the null: entitlement to a workspace's shared library is proved by naming a
  // canvas the registry agrees is in it.
  test('a shared-tier write is readable back from the shared tier of that workspace', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');

    const written = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, tier: 'shared', userId: 'u_1', name: 'Legend', source: 'shared source' } },
      { db },
    );
    expect(written.status).toBe(200);

    const shared = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, tier: 'shared', name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await shared.json()).source).toBe('shared source');
    // …and it did NOT land in the calling canvas's own library: the tier is a real distinction.
    const own = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await own.json()).source).toBeNull();
  });

  test('a shared-tier write for a workspace the caller cannot name a canvas in is refused', async () => {
    const db = await freshDb();
    const victim = await registerCanvas(db, 'ws_victim');
    await registerCanvas(db, 'ws_intruder');

    // Naming someone else's canvas under your own workspace: the pair is a lie, so 403.
    const stolen = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_intruder', canvasId: victim, tier: 'shared', userId: 'u_1', name: 'Legend', source: 'x' } },
      { db },
    );
    expect(stolen.status).toBe(403);

    // Naming no real canvas at all — the shape that would let any authenticated container
    // write into any workspace's shared library if the check degenerated to nothing.
    const invented = await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_victim', canvasId: 'cv_never_registered', tier: 'shared', userId: 'u_1', name: 'Legend', source: 'x' } },
      { db },
    );
    expect(invented.status).toBe(403);

    expect(await d1RecordStore(db).get({ workspaceId: 'ws_victim', canvasId: null, name: 'Legend' })).toBeNull();
    expect(await d1RecordStore(db).get({ workspaceId: 'ws_intruder', canvasId: null, name: 'Legend' })).toBeNull();
  });

  test('each workspace has its own shared library', async () => {
    const db = await freshDb();
    const [a, b] = [await registerCanvas(db, 'ws_a'), await registerCanvas(db, 'ws_b')];
    await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId: a, tier: 'shared', userId: 'u_1', name: 'Legend', source: 'a source' } },
      { db },
    );

    const other = await rpc({ op: 'component.read', input: { workspaceId: 'ws_b', canvasId: b, tier: 'shared', name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await other.json()).source).toBeNull();
  });
});

describe('platform RPC: component.promote / component.adopt', () => {
  test('promote moves the Component into the shared library and out of the canvas', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    await rpc({ op: 'component.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Legend', source: 'v1' } }, { db });

    const promoted = await rpc({ op: 'component.promote', input: { workspaceId: 'ws_a', canvasId, userId: 'u_2', name: 'Legend' } }, { db });
    expect(promoted.status).toBe(200);

    const shared = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, tier: 'shared', name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await shared.json()).source).toBe('v1');
    const own = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await own.json()).source).toBeNull();
  });

  test('adopt copies the shared Component into the canvas and leaves it shared', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, tier: 'shared', userId: 'u_1', name: 'Legend', source: 'shared source' } },
      { db },
    );

    const adopted = await rpc({ op: 'component.adopt', input: { workspaceId: 'ws_a', canvasId, userId: 'u_2', name: 'Legend' } }, { db });
    expect(adopted.status).toBe(200);

    const own = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await own.json()).source).toBe('shared source');
    const shared = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, tier: 'shared', name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await shared.json()).source).toBe('shared source');
  });

  test('promote and adopt are refused for a canvas that is not in the named workspace', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_owner');
    await rpc({ op: 'component.write', input: { workspaceId: 'ws_owner', canvasId, userId: 'u_1', name: 'Legend', source: 'v1' } }, { db });

    const promote = await rpc({ op: 'component.promote', input: { workspaceId: 'ws_intruder', canvasId, userId: 'u_1', name: 'Legend' } }, { db });
    expect(promote.status).toBe(403);
    const adopt = await rpc({ op: 'component.adopt', input: { workspaceId: 'ws_intruder', canvasId, userId: 'u_1', name: 'Legend' } }, { db });
    expect(adopt.status).toBe(403);
    // The Component is still exactly where its owner left it.
    expect((await d1RecordStore(db).get({ workspaceId: 'ws_owner', canvasId, name: 'Legend' }))?.source).toBe('v1');
  });

  test('a promote the store refuses is a failure, not a success — and nothing moves', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    await rpc({ op: 'component.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Legend', source: 'v1' } }, { db });
    await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, tier: 'shared', userId: 'u_1', name: 'Legend', source: 'theirs' } },
      { db },
    );

    const res = await rpc({ op: 'component.promote', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Legend' } }, { db });
    expect(res.status).toBe(400);
    expect((await d1RecordStore(db).get({ workspaceId: 'ws_a', canvasId, name: 'Legend' }))?.source).toBe('v1');
    expect((await d1RecordStore(db).get({ workspaceId: 'ws_a', canvasId: null, name: 'Legend' }))?.source).toBe('theirs');
  });
});

describe('platform RPC: component.write / component.read (history)', () => {
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

// The listing verb (#363). The container asks rather than reading its own directories, because
// after a recycle those directories are empty while the Records are not — and because only the
// edge can put the image-only PLATFORM tier in the same answer.
describe('platform RPC: component.list', () => {
  test('answers all three tiers at once, each labelled with the tier it resolves in', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const write = (tier: 'own' | 'shared', name: string, source: string) =>
      rpc({ op: 'component.write', input: { workspaceId: 'ws_a', canvasId, tier, userId: 'u_1', name, source } }, { db });
    await write('own', 'OwnCard', '// Mine.\n');
    await write('shared', 'SharedCard', '// The workspace copy.\n');

    const res = await rpc({ op: 'component.list', input: { workspaceId: 'ws_a', canvasId } }, { db });
    expect(res.status).toBe(200);
    const { components } = ComponentListOutput.parse(await res.json());
    expect(components).toContainEqual({ name: 'OwnCard', description: 'Mine.', tier: 'own' });
    expect(components).toContainEqual({ name: 'SharedCard', description: 'The workspace copy.', tier: 'shared' });
    // The platform tier comes from the manifest bundled with the worker — no filesystem.
    expect(components.find((c) => c.name === 'MarkdownCard')?.tier).toBe('base');
  });

  test('the edge refuses a canvas that does not belong to the named workspace', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_owner');
    const res = await rpc({ op: 'component.list', input: { workspaceId: 'ws_intruder', canvasId } }, { db });
    expect(res.status).toBe(403);
  });
});

// Workspace skills as Records (#361). Same "the edge owns the rows" shape as the Component
// verbs, but a two-level key (the skill, then the path inside it) — a skill is a DIRECTORY.
// `skill.list` answers with the workspace's WHOLE tree because that is the only question
// materialization ever asks: the agent SDK discovers skills by SCANNING a directory.
describe('platform RPC: skill.write / skill.list', () => {
  const makeWorkspace = async (db: Awaited<ReturnType<typeof freshDb>>) => {
    await db.insert(user).values({ id: 'u_owner', name: 'Owner', email: 'owner@example.com' }).onConflictDoNothing();
    return (await createWorkspace(db, { name: 'W', ownerUserId: 'u_owner' })).id;
  };

  test('an uploaded multi-file skill comes back as the workspace tree', async () => {
    const db = await freshDb();
    const workspaceId = await makeWorkspace(db);

    const written = await rpc(
      {
        op: 'skill.write',
        input: {
          workspaceId,
          userId: 'u_1',
          skill: 'corpus-linguist',
          files: [
            { path: 'SKILL.md', content: '---\nname: corpus-linguist\n---\nbody' },
            { path: 'data/corpus.yaml', content: 'a: 1' },
          ],
        },
      },
      { db },
    );
    expect(written.status).toBe(200);
    expect(SkillWriteOutput.parse(await written.json()).files).toBe(2);

    const listed = await rpc({ op: 'skill.list', input: { workspaceId } }, { db });
    expect(listed.status).toBe(200);
    expect(SkillListOutput.parse(await listed.json()).files).toEqual([
      { skill: 'corpus-linguist', path: 'SKILL.md', content: '---\nname: corpus-linguist\n---\nbody' },
      { skill: 'corpus-linguist', path: 'data/corpus.yaml', content: 'a: 1' },
    ]);
  });

  test('a workspace with no skills lists an empty tree, not an error', async () => {
    const db = await freshDb();
    const listed = await rpc({ op: 'skill.list', input: { workspaceId: await makeWorkspace(db) } }, { db });
    expect(listed.status).toBe(200);
    expect(SkillListOutput.parse(await listed.json()).files).toEqual([]);
  });

  test('one workspace never sees another workspace’s skills', async () => {
    const db = await freshDb();
    const mine = await makeWorkspace(db);
    const theirs = await makeWorkspace(db);
    await rpc(
      { op: 'skill.write', input: { workspaceId: theirs, userId: 'u_1', skill: 'secret', files: [{ path: 'SKILL.md', content: 'x' }] } },
      { db },
    );

    const listed = await rpc({ op: 'skill.list', input: { workspaceId: mine } }, { db });
    expect(SkillListOutput.parse(await listed.json()).files).toEqual([]);
  });

  test('the edge refuses a workspace that does not exist', async () => {
    const db = await freshDb();
    const res = await rpc(
      { op: 'skill.write', input: { workspaceId: 'ws_never_created', userId: 'u_1', skill: 'x', files: [{ path: 'SKILL.md', content: 'x' }] } },
      { db },
    );
    expect(res.status).toBe(403);
  });

  test('the legacy default workspace is writable without a registry row', async () => {
    const db = await freshDb();
    const res = await rpc(
      { op: 'skill.write', input: { workspaceId: 'default', userId: 'u_1', skill: 'x', files: [{ path: 'SKILL.md', content: 'x' }] } },
      { db },
    );
    expect(res.status).toBe(200);
  });

  test.each([['../escape.md'], ['/etc/passwd'], ['.hidden']])(
    'the edge validates the file path itself — %p never reaches the store',
    async (path) => {
      const db = await freshDb();
      const res = await rpc(
        { op: 'skill.write', input: { workspaceId: await makeWorkspace(db), userId: 'u_1', skill: 'ok', files: [{ path, content: 'x' }] } },
        { db },
      );
      expect(res.status).toBe(400);
    },
  );

  test('the edge validates the skill name itself — a traversing name is a 400', async () => {
    const db = await freshDb();
    const res = await rpc(
      {
        op: 'skill.write',
        input: { workspaceId: await makeWorkspace(db), userId: 'u_1', skill: '../evil', files: [{ path: 'SKILL.md', content: 'x' }] },
      },
      { db },
    );
    expect(res.status).toBe(400);
  });

  test('a re-upload bumps the file’s rev and history records who wrote each one', async () => {
    const db = await freshDb();
    const workspaceId = await makeWorkspace(db);
    const upload = (userId: string, content: string) =>
      rpc({ op: 'skill.write', input: { workspaceId, userId, skill: 'linter', files: [{ path: 'SKILL.md', content }] } }, { db });
    await upload('u_1', 'v1');
    await upload('u_2', 'v2');

    const versions = await d1SkillFileStore(db).listVersions({ workspaceId, skill: 'linter', path: 'SKILL.md' });
    expect(versions.map((v) => [v.version, v.content, v.createdBy])).toEqual([
      [2, 'v2', 'u_2'],
      [1, 'v1', 'u_1'],
    ]);
  });
});

describe('platform RPC: data.write / data.read', () => {
  test('a written data file is readable back as a Record', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');

    const written = await rpc(
      { op: 'data.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'sales.json', source: '{"rows":[1]}' } },
      { db },
    );
    expect(written.status).toBe(200);
    expect(DataWriteOutput.parse(await written.json()).rev).toBe(1);

    const read = await rpc({ op: 'data.read', input: { workspaceId: 'ws_a', canvasId, name: 'sales.json' } }, { db });
    expect(DataReadOutput.parse(await read.json()).source).toBe('{"rows":[1]}');
  });

  test('reading a data file nobody wrote answers "absent", not an error', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const read = await rpc({ op: 'data.read', input: { workspaceId: 'ws_a', canvasId, name: 'ghost.csv' } }, { db });
    expect(read.status).toBe(200);
    expect(DataReadOutput.parse(await read.json()).source).toBeNull();
  });

  test('the edge refuses a canvas that does not belong to the named workspace', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_owner');

    const res = await rpc(
      { op: 'data.write', input: { workspaceId: 'ws_intruder', canvasId, userId: 'u_1', name: 'sales.json', source: '[]' } },
      { db },
    );
    expect(res.status).toBe(403);
    const read = await rpc({ op: 'data.read', input: { workspaceId: 'ws_owner', canvasId, name: 'sales.json' } }, { db });
    expect(DataReadOutput.parse(await read.json()).source).toBeNull();
  });

  test.each([['evil.tsx'], ['../../etc/passwd'], ['noext']])('the edge refuses the name %p at the boundary', async (name) => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc({ op: 'data.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name, source: 'x' } }, { db });
    expect(res.status).toBe(400);
  });

  test('unparseable JSON is a 400 the agent can act on, not a 5xx that reads as a store failure', async () => {
    // The distinction matters: a 5xx means "retry", and retrying a payload that will never
    // parse is a loop. The store's own rule has to surface as a client error.
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc(
      { op: 'data.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'sales.json', source: '{nope' } },
      { db },
    );
    expect(res.status).toBe(400);

    const read = await rpc({ op: 'data.read', input: { workspaceId: 'ws_a', canvasId, name: 'sales.json' } }, { db });
    expect(DataReadOutput.parse(await read.json()).source).toBeNull();
  });

  test('the edge refuses a data file over the cap — a large upload cannot reach the store', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc(
      { op: 'data.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'big.txt', source: 'x'.repeat(DATA_MAX_BYTES + 1) } },
      { db },
    );
    expect(res.status).toBe(400);
  });

  test('a data file far larger than D1 max SQL statement round-trips — values are bound', async () => {
    // D1's maximum SQL *statement* is 100 KB. This is the payload that makes a data file
    // different from a 20 KB Component: interpolated into SQL it would fail outright.
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const big = 'x'.repeat(400_000);

    const written = await rpc(
      { op: 'data.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'big.txt', source: big } },
      { db },
    );
    expect(written.status).toBe(200);

    const read = await rpc({ op: 'data.read', input: { workspaceId: 'ws_a', canvasId, name: 'big.txt' } }, { db });
    expect(DataReadOutput.parse(await read.json()).source).toBe(big);
  });

  test('a rewrite bumps the rev and appends a version, exactly as a Component does', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'sales.csv' };
    await rpc({ op: 'data.write', input: { ...input, userId: 'u_1', source: 'a,b' } }, { db });
    const second = await rpc({ op: 'data.write', input: { ...input, userId: 'u_2', source: 'c,d' } }, { db });

    expect(DataWriteOutput.parse(await second.json()).rev).toBe(2);
    const versions = await d1RecordStore(db).listVersions({ workspaceId: 'ws_a', canvasId, name: 'sales.csv' });
    expect(versions.map((v) => [v.version, v.source, v.createdBy])).toEqual([
      [2, 'c,d', 'u_2'],
      [1, 'a,b', 'u_1'],
    ]);
  });
});

describe('platform RPC: component.restore', () => {
  // The verb that turns history into recovery (#362). Its SHAPE is the point: the container
  // names a VERSION, and the read-then-put happens entirely here, at the edge. The source
  // never makes the trip out and back — so a restore cannot be forged by a container
  // composing a payload, and a large Component is not shipped twice for no reason.
  test('write v1, write v2, restore v1 — v1 is current again and a v3 records the restore', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v1 source' } }, { db });
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v2 source' } }, { db });

    const restored = await rpc({ op: 'component.restore', input: { ...input, userId: 'u_2', version: 1 } }, { db });
    expect(restored.status).toBe(200);
    expect(ComponentRestoreOutput.parse(await restored.json()).rev).toBe(3);

    const read = await rpc({ op: 'component.read', input }, { db });
    expect(ComponentReadOutput.parse(await read.json()).source).toBe('v1 source');

    // Append-only: the version that was replaced is still on the record, and the restore is
    // attributed to whoever performed it rather than to the author of the text brought back.
    const { versions } = ComponentHistoryOutput.parse(await (await rpc({ op: 'component.history', input }, { db })).json());
    expect(versions.map((v) => [v.version, v.createdBy])).toEqual([
      [3, 'u_2'],
      [2, 'u_1'],
      [1, 'u_1'],
    ]);
  });

  test('the request names a version, never a source — the edge is where the old text is read', async () => {
    // Structural, not incidental: `component.restore` has no `source` field to carry one, so
    // a container cannot restore a Component to text of its own invention, and the corpus
    // does not cross the hop twice. A `source` in the payload is simply not part of the verb.
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'the real v1' } }, { db });

    const res = await rpc({ op: 'component.restore', input: { ...input, userId: 'u_1', version: 1, source: 'forged' } }, { db });
    expect(res.status).toBe(200);
    // The reply carries the new revision and nothing else — the source stayed on this side.
    expect(await res.json()).toEqual({ rev: 2 });
    const read = await rpc({ op: 'component.read', input }, { db });
    expect(ComponentReadOutput.parse(await read.json()).source).toBe('the real v1');
  });

  test('restoring a soft-deleted Component brings it back into the tier', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v1 source' } }, { db });
    await d1RecordStore(db).softDelete({ workspaceId: 'ws_a', canvasId, name: 'Card' });
    expect(ComponentReadOutput.parse(await (await rpc({ op: 'component.read', input }, { db })).json()).source).toBeNull();

    expect((await rpc({ op: 'component.restore', input: { ...input, userId: 'u_1', version: 1 } }, { db })).status).toBe(200);

    expect(ComponentReadOutput.parse(await (await rpc({ op: 'component.read', input }, { db })).json()).source).toBe('v1 source');
    expect((await d1RecordStore(db).list({ workspaceId: 'ws_a', canvasId })).map((r) => r.name)).toEqual(['Card']);
  });

  test('the SHARED tier can be restored too, and the own tier is not what moves', async () => {
    // #359 made the shared library a Record, so its versions exist and `component.history`
    // will list them. A restore that quietly only ever touched the own tier would leave the
    // shared tier with a history and no way to act on it — and worse, would fork the one live
    // source into this canvas, which is the thing promote exists to prevent.
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const shared = { workspaceId: 'ws_a', canvasId, tier: 'shared' as const, name: 'Legend' };
    await rpc({ op: 'component.write', input: { ...shared, userId: 'u_1', source: 'shared v1' } }, { db });
    await rpc({ op: 'component.write', input: { ...shared, userId: 'u_1', source: 'shared v2' } }, { db });

    const restored = await rpc({ op: 'component.restore', input: { ...shared, userId: 'u_2', version: 1 } }, { db });
    expect(restored.status).toBe(200);
    expect(ComponentRestoreOutput.parse(await restored.json()).rev).toBe(3);

    const read = await rpc({ op: 'component.read', input: shared }, { db });
    expect(ComponentReadOutput.parse(await read.json()).source).toBe('shared v1');
    // The canvas's own library was never written into — the restore stayed in the tier it named.
    const own = await rpc({ op: 'component.read', input: { workspaceId: 'ws_a', canvasId, tier: 'own', name: 'Legend' } }, { db });
    expect(ComponentReadOutput.parse(await own.json()).source).toBeNull();
  });

  test('a shared restore still proves entitlement through the canvas it names', async () => {
    // The shared library has no canvas, so the null key is minted at the EDGE and the caller
    // names a real canvas to be checked. A canvas outside the workspace is refused, which is
    // the only thing standing between a caller and another workspace's shared library.
    const db = await freshDb();
    const victim = await registerCanvas(db, 'ws_victim');
    await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_victim', canvasId: victim, tier: 'shared', userId: 'u_1', name: 'Legend', source: 'v1' } },
      { db },
    );

    const res = await rpc(
      { op: 'component.restore', input: { workspaceId: 'ws_intruder', canvasId: victim, tier: 'shared', userId: 'u_x', name: 'Legend', version: 1 } },
      { db },
    );
    expect(res.status).toBe(403);
  });

  test('a version that does not exist is a clean 404, not a 500 and not a silent success', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const input = { workspaceId: 'ws_a', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v1 source' } }, { db });

    const res = await rpc({ op: 'component.restore', input: { ...input, userId: 'u_1', version: 7 } }, { db });
    expect(res.status).toBe(404);
    // And nothing was written: a refused restore must not append a version of its own.
    const { versions } = ComponentHistoryOutput.parse(await (await rpc({ op: 'component.history', input }, { db })).json());
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  test('a version of a DIFFERENT Component cannot be restored into this one', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    await rpc(
      { op: 'component.write', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Other', source: 'other v1' } },
      { db },
    );

    const res = await rpc(
      { op: 'component.restore', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Card', version: 1 } },
      { db },
    );
    expect(res.status).toBe(404);
  });

  test('the edge refuses a canvas that does not belong to the named workspace', async () => {
    // A restore IS a write, so it needs at least the ownership gate a write has: without it a
    // caller could reach into another workspace's canvas and make an old revision current.
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_owner');
    const input = { workspaceId: 'ws_owner', canvasId, name: 'Card' };
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v1 source' } }, { db });
    await rpc({ op: 'component.write', input: { ...input, userId: 'u_1', source: 'v2 source' } }, { db });

    const res = await rpc(
      { op: 'component.restore', input: { workspaceId: 'ws_intruder', canvasId, userId: 'u_x', name: 'Card', version: 1 } },
      { db },
    );
    expect(res.status).toBe(403);
    // Refused means refused: the Component the intruder aimed at is untouched.
    expect(ComponentReadOutput.parse(await (await rpc({ op: 'component.read', input }, { db })).json()).source).toBe('v2 source');
  });

  test('an unauthenticated caller cannot restore', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    const res = await rpc(
      { op: 'component.restore', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Card', version: 1 } },
      { db, token: null },
    );
    expect(res.status).toBe(401);
  });

  test('a version number that is not a version at all is a 400 at the boundary', async () => {
    const db = await freshDb();
    const canvasId = await registerCanvas(db, 'ws_a');
    for (const version of [0, -1, 1.5]) {
      const res = await rpc(
        { op: 'component.restore', input: { workspaceId: 'ws_a', canvasId, userId: 'u_1', name: 'Card', version } },
        { db },
      );
      expect(res.status).toBe(400);
    }
  });
});
