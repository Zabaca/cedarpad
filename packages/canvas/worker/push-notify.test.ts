import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { makeDb } from '../web-poc/lib/db/index.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import { PushPayload } from '../shared/push-contract.ts';
import { makeAssignmentPushNotify, makePushNotify, type PushSendResult } from './push-notify.ts';
import { user, workspaceMembers, workspaces } from '../web-poc/lib/db/schema.ts';

// In-memory DB built from the real Drizzle migrations (mirrors inbox.test.ts).
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

const conv = (over: Partial<ConversationRow> = {}) =>
  ({
    id: 'conv_1',
    sessionId: 'sess_1',
    summary: 'Refactor the bridge',
    ...over,
  }) as ConversationRow;

const device = (name: string) => ({
  endpoint: `https://push.example.com/${name}`,
  keys: { p256dh: `p_${name}`, auth: `a_${name}` },
});

/** A recording sender; `outcomes` maps endpoint → what the push service "answered". */
function recorder(outcomes: Record<string, PushSendResult | Error> = {}) {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  const send = async (sub: { endpoint: string }, payload: string): Promise<PushSendResult> => {
    sent.push({ endpoint: sub.endpoint, payload });
    const outcome = outcomes[sub.endpoint];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? 'delivered';
  };
  return { sent, send };
}

describe('web push notify (#87)', () => {
  test('pushes to EVERY device the user has subscribed', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'user_a', device('laptop'));
    await pushStore.save(db, 'user_a', device('phone'));
    const rec = recorder();

    await makePushNotify({ db, userId: 'user_a', origin: 'https://app.cedarpad.com', send: rec.send })(
      conv(),
      'Which branch should I target?',
    );

    expect(rec.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example.com/laptop',
      'https://push.example.com/phone',
    ]);
  });

  test('the payload satisfies the PushPayload contract and deep-links to the Inbox item', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'user_a', device('laptop'));
    const rec = recorder();

    await makePushNotify({ db, userId: 'user_a', origin: 'https://app.cedarpad.com', send: rec.send })(
      conv({ id: 'conv_42', summary: 'Refactor the bridge' }),
      'Which branch should I target?',
    );

    const payload = PushPayload.parse(JSON.parse(rec.sent[0]?.payload ?? '{}'));
    expect(payload.body).toBe('Which branch should I target?');
    expect(payload.title).toContain('Refactor the bridge');
    expect(payload.conversationId).toBe('conv_42');
    expect(payload.url).toBe('https://app.cedarpad.com/?stage=inbox&conv=conv_42');
  });

  test('a long question is truncated so the notification body stays readable', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'user_a', device('laptop'));
    const rec = recorder();

    await makePushNotify({ db, userId: 'user_a', origin: 'https://x.test', send: rec.send })(
      conv(),
      'q'.repeat(500),
    );

    const payload = PushPayload.parse(JSON.parse(rec.sent[0]?.payload ?? '{}'));
    expect(payload.body.length).toBeLessThanOrEqual(200);
    expect(payload.body.endsWith('…')).toBe(true);
  });

  test('a gone endpoint is pruned from the store; live devices are untouched', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'user_a', device('dead'));
    await pushStore.save(db, 'user_a', device('live'));
    const rec = recorder({ 'https://push.example.com/dead': 'gone' });

    await makePushNotify({ db, userId: 'user_a', origin: 'https://x.test', send: rec.send })(conv(), 'q');

    const left = await pushStore.listForUser(db, 'user_a');
    expect(left.map((r) => r.endpoint)).toEqual(['https://push.example.com/live']);
  });

  test('one device throwing does not stop the others and does not reject (notify is best-effort)', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'user_a', device('flaky'));
    await pushStore.save(db, 'user_a', device('ok'));
    const rec = recorder({ 'https://push.example.com/flaky': new Error('503 from push service') });

    await expect(
      makePushNotify({ db, userId: 'user_a', origin: 'https://x.test', send: rec.send })(conv(), 'q'),
    ).resolves.toBeUndefined();

    expect(rec.sent).toHaveLength(2);
    // A transient failure must NOT prune the device — only an explicit `gone` does.
    expect(await pushStore.listForUser(db, 'user_a')).toHaveLength(2);
  });

  test('no subscriptions → no sends, no throw', async () => {
    const db = await freshDb();
    const rec = recorder();
    await makePushNotify({ db, userId: 'user_none', origin: 'https://x.test', send: rec.send })(conv(), 'q');
    expect(rec.sent).toHaveLength(0);
  });

  test('a Conversation with no summary still gets a sensible title', async () => {
    const db = await freshDb();
    await pushStore.save(db, 'user_a', device('laptop'));
    const rec = recorder();

    await makePushNotify({ db, userId: 'user_a', origin: 'https://x.test', send: rec.send })(
      conv({ summary: null }),
      'q',
    );

    const payload = PushPayload.parse(JSON.parse(rec.sent[0]?.payload ?? '{}'));
    expect(payload.title.length).toBeGreaterThan(0);
  });
});

/** Seed a workspace with an owner plus N extra members (all real `user` rows). */
async function seedWorkspace(
  db: Awaited<ReturnType<typeof freshDb>>,
  input: { workspaceId: string; ownerUserId: string; memberUserIds?: string[] },
) {
  for (const id of [input.ownerUserId, ...(input.memberUserIds ?? [])]) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.com` }).onConflictDoNothing();
  }
  await db
    .insert(workspaces)
    .values({ id: input.workspaceId, name: input.workspaceId, ownerUserId: input.ownerUserId });
  for (const id of input.memberUserIds ?? []) {
    await db
      .insert(workspaceMembers)
      .values({ id: `wm_${input.workspaceId}_${id}`, workspaceId: input.workspaceId, userId: id });
  }
}

describe('push recipients follow assignment (#231)', () => {
  test('an ASSIGNED conversation pings the assignee only', async () => {
    const db = await freshDb();
    await seedWorkspace(db, { workspaceId: 'ws_1', ownerUserId: 'user_owner', memberUserIds: ['user_b'] });
    await pushStore.save(db, 'user_owner', device('owner-laptop'));
    await pushStore.save(db, 'user_b', device('b-phone'));
    const rec = recorder();

    await makeAssignmentPushNotify({ db, origin: 'https://x.test', send: rec.send })(
      conv({ workspaceId: 'ws_1', assignedTo: 'user_b' }),
      'q',
    );

    expect(rec.sent.map((s) => s.endpoint)).toEqual(['https://push.example.com/b-phone']);
  });

  test('an UNASSIGNED conversation pings every workspace member', async () => {
    const db = await freshDb();
    await seedWorkspace(db, {
      workspaceId: 'ws_1',
      ownerUserId: 'user_owner',
      memberUserIds: ['user_b', 'user_c'],
    });
    await pushStore.save(db, 'user_owner', device('owner-laptop'));
    await pushStore.save(db, 'user_b', device('b-phone'));
    await pushStore.save(db, 'user_c', device('c-tablet'));
    const rec = recorder();

    await makeAssignmentPushNotify({ db, origin: 'https://x.test', send: rec.send })(
      conv({ workspaceId: 'ws_1', assignedTo: null }),
      'q',
    );

    expect(rec.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example.com/b-phone',
      'https://push.example.com/c-tablet',
      'https://push.example.com/owner-laptop',
    ]);
  });

  test('the owner also holding a member row is pushed once per endpoint', async () => {
    const db = await freshDb();
    await seedWorkspace(db, { workspaceId: 'ws_1', ownerUserId: 'user_owner', memberUserIds: ['user_owner'] });
    await pushStore.save(db, 'user_owner', device('owner-laptop'));
    const rec = recorder();

    await makeAssignmentPushNotify({ db, origin: 'https://x.test', send: rec.send })(
      conv({ workspaceId: 'ws_1', assignedTo: null }),
      'q',
    );

    expect(rec.sent.map((s) => s.endpoint)).toEqual(['https://push.example.com/owner-laptop']);
  });

  test('a member with no subscriptions is skipped silently', async () => {
    const db = await freshDb();
    await seedWorkspace(db, { workspaceId: 'ws_1', ownerUserId: 'user_owner', memberUserIds: ['user_quiet'] });
    await pushStore.save(db, 'user_owner', device('owner-laptop'));
    const rec = recorder();

    await expect(
      makeAssignmentPushNotify({ db, origin: 'https://x.test', send: rec.send })(
        conv({ workspaceId: 'ws_1', assignedTo: null }),
        'q',
      ),
    ).resolves.toBeUndefined();

    expect(rec.sent.map((s) => s.endpoint)).toEqual(['https://push.example.com/owner-laptop']);
  });

  test('a single-member workspace behaves exactly as before — every device of the one member', async () => {
    const db = await freshDb();
    await seedWorkspace(db, { workspaceId: 'ws_1', ownerUserId: 'user_a' });
    await pushStore.save(db, 'user_a', device('laptop'));
    await pushStore.save(db, 'user_a', device('phone'));
    const rec = recorder();

    await makeAssignmentPushNotify({ db, origin: 'https://x.test', send: rec.send })(
      conv({ workspaceId: 'ws_1', assignedTo: null }),
      'q',
    );

    expect(rec.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example.com/laptop',
      'https://push.example.com/phone',
    ]);
  });

  test('a gone endpoint is still pruned when reached through the assignment layer', async () => {
    const db = await freshDb();
    await seedWorkspace(db, { workspaceId: 'ws_1', ownerUserId: 'user_owner', memberUserIds: ['user_b'] });
    await pushStore.save(db, 'user_b', device('dead'));
    const rec = recorder({ 'https://push.example.com/dead': 'gone' });

    await makeAssignmentPushNotify({ db, origin: 'https://x.test', send: rec.send })(
      conv({ workspaceId: 'ws_1', assignedTo: 'user_b' }),
      'q',
    );

    expect(await pushStore.listForUser(db, 'user_b')).toHaveLength(0);
  });
});
