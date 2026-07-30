import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient, type Client, type InArgs, type InStatement } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { createWorkspace, setInboxReadAt } from '../web-poc/lib/db/queries/workspaces.ts';
import { inboxBadgeSource, inboxBadgeStream, type HubSocket } from './inbox-badge.ts';

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

// The stream around the source: what drives it, and what it writes. Real timers with tiny
// intervals rather than a fake clock — the thing being pinned is that a NOTIFICATION beats
// the timers, so the timers have to be able to fire and lose.
function fakeHub() {
  const listeners = new Map<string, ((ev: { data?: string }) => void)[]>();
  let closed = false;
  const socket: HubSocket = {
    addEventListener: (type, cb) => listeners.set(type, [...(listeners.get(type) ?? []), cb as never]),
    close: () => {
      closed = true;
    },
  };
  return {
    socket,
    get closed() {
      return closed;
    },
    emit: (type: string, data?: string) => listeners.get(type)?.forEach((cb) => cb({ data })),
  };
}

/** Read frames until `count` of them have arrived, or the stream ends. */
async function readFrames(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    frames.push(dec.decode(value));
  }
  void reader.cancel().catch(() => {});
  return frames;
}

describe('inboxBadgeStream — the hub drives it, the timers only back it up', () => {
  const slowTimers = { keepAliveMs: 60_000, safetyNetMs: 60_000 };

  test('opens with the current badge, then pushes again the moment the hub says so', async () => {
    const ws = (await createWorkspace(database, { name: 'Pushed live', ownerUserId: USER })).id;
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, slowTimers);
    const reader = stream.getReader();
    const dec = new TextDecoder();

    expect(dec.decode((await reader.read()).value)).toBe('data: {"count":0,"readAt":0}\n\n');

    await conversations.create(database, { sessionId: 's_live', userId: USER, workspaceId: ws });
    hub.emit('message', JSON.stringify({ topic: 'inbox' }));
    // No timer has fired — with a 60s keep-alive this frame can only have come from the hub.
    expect(dec.decode((await reader.read()).value)).toBe('data: {"count":1,"readAt":0}\n\n');
    await reader.cancel();
  });

  test('a notice that changes nothing the badge counts writes no frame at all', async () => {
    const ws = (await createWorkspace(database, { name: 'Quiet notice', ownerUserId: USER })).id;
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, {
      keepAliveMs: 25,
      safetyNetMs: 60_000,
    });
    const [first, second] = await readFrames(stream, 2);
    expect(first).toBe('data: {"count":0,"readAt":0}\n\n');
    // The second frame is the keep-alive, not a repeat of the count — the notice fired but
    // the number did not move.
    hub.emit('message', JSON.stringify({ topic: 'inbox' }));
    expect(second).toBe(': keep-alive\n\n');
  });

  test('an unparseable notice is ignored rather than pushed through', async () => {
    const ws = (await createWorkspace(database, { name: 'Bad notice', ownerUserId: USER })).id;
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, {
      keepAliveMs: 25,
      safetyNetMs: 60_000,
    });
    const reader = stream.getReader();
    await reader.read(); // the opening badge

    await conversations.create(database, { sessionId: 's_bad', userId: USER, workspaceId: ws });
    hub.emit('message', 'not json');
    hub.emit('message', JSON.stringify({ topic: 'presence' }));
    // Whatever comes next is the keep-alive, not a badge pushed by a notice we could not read.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': keep-alive\n\n');
    await reader.cancel();
  });

  // The current 10s tick doubles as departed-client detection. An event-driven stream with
  // no traffic would never notice a client that vanished, and those streams accumulate.
  test('an idle stream still writes, so a departed client is still detected', async () => {
    const ws = (await createWorkspace(database, { name: 'Idle', ownerUserId: USER })).id;
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), fakeHub().socket, {
      keepAliveMs: 15,
      safetyNetMs: 60_000,
    });
    const frames = await readFrames(stream, 3);
    expect(frames.slice(1)).toEqual([': keep-alive\n\n', ': keep-alive\n\n']);
  });

  test('the safety net still lands a change the hub never reported', async () => {
    const ws = (await createWorkspace(database, { name: 'Lost notice', ownerUserId: USER })).id;
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), fakeHub().socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 15,
    });
    const reader = stream.getReader();
    await reader.read(); // the opening badge

    // Nobody rings the hub. The badge must still get there.
    await conversations.create(database, { sessionId: 's_lost', userId: USER, workspaceId: ws });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"count":1,"readAt":0}\n\n');
    await reader.cancel();
  });

  test('a stream with no hub at all still works — it is just as slow as it used to be', async () => {
    const ws = (await createWorkspace(database, { name: 'Hubless', ownerUserId: USER })).id;
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), null, { keepAliveMs: 60_000, safetyNetMs: 15 });
    const reader = stream.getReader();
    await reader.read();
    await conversations.create(database, { sessionId: 's_hubless', userId: USER, workspaceId: ws });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"count":1,"readAt":0}\n\n');
    await reader.cancel();
  });

  test('cancelling the stream releases the hub socket — no subscriber outlives its tab', async () => {
    const ws = (await createWorkspace(database, { name: 'Cancelled', ownerUserId: USER })).id;
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, slowTimers);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(hub.closed).toBe(true);
  });

  // A code deploy restarts the hub and drops its sockets. Ending the stream is what makes
  // that self-healing: EventSource reconnects, and the new stream subscribes to the new hub.
  test('the hub going away ends the stream, so the client reconnects onto a fresh one', async () => {
    const ws = (await createWorkspace(database, { name: 'Hub restart', ownerUserId: USER })).id;
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, slowTimers);
    const reader = stream.getReader();
    await reader.read();
    hub.emit('close');
    expect((await reader.read()).done).toBe(true);
  });
});
