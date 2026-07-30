import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient, type Client, type InArgs, type InStatement } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { createWorkspace, setInboxReadAt } from '../web-poc/lib/db/queries/workspaces.ts';
import { inboxBadgeSource } from './inbox-badge.ts';

// What the nav-badge stream COSTS per connected tab, measured rather than asserted (#383).
// The stream used to re-read the whole inbox every 10s per tab: 187,855 read queries and
// 1,600,703 rows in 24h of production, to recompute one number ~2,000 times per actual
// change. What is pinned here is the shape that fixes it — a cheap watermark probe that
// only escalates to a full read when something moved — and the counts it produces.

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

/** A libSQL client that counts what passes through it, so "rows read per tick" is a
 *  measurement and not a claim. Only `execute` is instrumented — Drizzle's libSQL driver
 *  runs every statement in this test through it. */
interface Meter {
  queries: number;
  rows: number;
}
function meteredClient(inner: Client, meter: Meter): Client {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'execute') return Reflect.get(target, prop, receiver);
      return async (stmt: InStatement, args?: InArgs) => {
        const res = await (args === undefined ? inner.execute(stmt) : inner.execute(stmt as string, args));
        meter.queries += 1;
        meter.rows += res.rows.length;
        return res;
      };
    },
  });
}

const raw = createClient({ url: ':memory:' });
const meter: Meter = { queries: 0, rows: 0 };
const db = drizzle(meteredClient(raw, meter), { schema });
const database = db as never;

const USER = 'user_badge';
let wsId = '';

/** Measure one call, from a zeroed meter. */
async function cost<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number; rows: number }> {
  meter.queries = 0;
  meter.rows = 0;
  const result = await fn();
  return { result, queries: meter.queries, rows: meter.rows };
}

/** Each mutation needs its own millisecond — the watermark is a timestamp. */
const tick = () => new Promise((r) => setTimeout(r, 2));

beforeAll(async () => {
  for (const stmt of migrationStatements()) await raw.execute(stmt);
  await raw.execute({ sql: 'insert into user (id, name, email) values (?, ?, ?)', args: [USER, USER, 'b@example.com'] });
  wsId = (await createWorkspace(database, { name: 'Badge', ownerUserId: USER })).id;
  // A realistic-sized workspace: production's whole conversations table is ~16 rows.
  for (let i = 0; i < 8; i++) {
    await conversations.create(database, { sessionId: `s_${i}`, userId: USER, workspaceId: wsId });
  }
  for (let i = 0; i < 4; i++) await canvasRegistry.create(database, { workspaceId: wsId, name: `cv ${i}` });
});

describe('inboxBadgeSource — the badge stream reads D1 only when something moved', () => {
  test('the first poll computes the badge from the rows', async () => {
    const source = inboxBadgeSource(database, wsId, USER);
    const { result } = await cost(() => source.poll());
    expect(result).toEqual({ count: 8, readAt: 0 });
  });

  test('a poll with nothing changed costs ONE query, and answers null (no frame to push)', async () => {
    const source = inboxBadgeSource(database, wsId, USER);
    await source.poll();

    const quiet = await cost(() => source.poll());
    expect(quiet.result).toBeNull();
    expect(quiet.queries).toBe(1);
    // …against the ~16 rows the old unconditional recompute read every single tick.
    expect(quiet.rows).toBeLessThanOrEqual(2);
  });

  test('a poll AFTER a change re-reads the rows and pushes the new count', async () => {
    const source = inboxBadgeSource(database, wsId, USER);
    expect((await source.poll())?.count).toBe(8);
    await tick();

    await conversations.create(database, { sessionId: 's_new', userId: USER, workspaceId: wsId });
    const moved = await cost(() => source.poll());
    expect(moved.result?.count).toBe(9);
    expect(moved.queries).toBeGreaterThan(1); // the watermark probe, then the real read
  });

  test('a change the badge cannot see moves the watermark but pushes no frame', async () => {
    const source = inboxBadgeSource(database, wsId, USER);
    const first = await source.poll();
    await tick();

    // Assignment is a triage act: it changes the row, never the count.
    const rows = await conversations.list(database, { workspaceId: wsId, status: 'open' });
    await conversations.assign(database, rows[0]!.id, USER);
    expect(await source.poll()).toBeNull();
    // …and the source has not lost track: the next real change still lands.
    await tick();
    await conversations.close(database, rows[0]!.id);
    expect((await source.poll())?.count).toBe(first!.count - 1);
  });

  test('stamping the shared read mark clears the badge for everyone watching', async () => {
    const ws = (await createWorkspace(database, { name: 'Read mark', ownerUserId: USER })).id;
    await conversations.create(database, { sessionId: 's_rm', userId: USER, workspaceId: ws });
    const source = inboxBadgeSource(database, ws, USER);
    expect((await source.poll())?.count).toBe(1);

    await tick();
    await setInboxReadAt(database, ws, new Date(Date.now() + 1000));
    const cleared = await source.poll();
    expect(cleared?.count).toBe(0);
    expect(cleared?.readAt).toBeGreaterThan(0);
  });

  test('push() recomputes without asking the watermark first — the hub already said so', async () => {
    const ws = (await createWorkspace(database, { name: 'Pushed', ownerUserId: USER })).id;
    const source = inboxBadgeSource(database, ws, USER);
    expect((await source.push())?.count).toBe(0);

    await conversations.create(database, { sessionId: 's_push', userId: USER, workspaceId: ws });
    const pushed = await cost(() => source.push());
    expect(pushed.result?.count).toBe(1);
    // A subsequent poll must not re-push the same number just because the rows moved.
    expect(await source.poll()).toBeNull();
  });

  test('a push that finds the same count answers null — the stream stays quiet', async () => {
    const ws = (await createWorkspace(database, { name: 'Idempotent', ownerUserId: USER })).id;
    const source = inboxBadgeSource(database, ws, USER);
    expect((await source.push())?.count).toBe(0);
    expect(await source.push()).toBeNull();
  });

  // The measurement the change exists for. `push()` is the old unconditional behaviour plus
  // the probe; `poll()` on a quiet workspace is the new one. Both are counted through the
  // same meter on the same rows, so the ratio is a measurement, not an estimate.
  test('MEASUREMENT: a quiet tick reads an order of magnitude fewer rows than a full recompute', async () => {
    const source = inboxBadgeSource(database, wsId, USER);
    await source.poll();
    await tick();

    const full = await cost(() => source.push());
    const quiet = await cost(() => source.poll());

    console.log(
      `[#383] full recompute: ${full.queries} queries / ${full.rows} rows — quiet tick: ${quiet.queries} query / ${quiet.rows} rows`,
    );
    expect(quiet.rows * 5).toBeLessThan(full.rows);
    expect(quiet.queries).toBe(1);
  });

  test('the badge is per-viewer: a private chat counts for its creator only', async () => {
    const ws = (await createWorkspace(database, { name: 'Private', ownerUserId: USER })).id;
    const conv = await conversations.create(database, {
      sessionId: 's_priv',
      userId: USER,
      workspaceId: ws,
      createdBy: USER,
    });
    await conversations.setVisibility(database, conv.id, 'private');

    expect((await inboxBadgeSource(database, ws, USER).poll())?.count).toBe(1);
    expect((await inboxBadgeSource(database, ws, 'someone_else').poll())?.count).toBe(0);
  });
});
