import { migrationStatements } from './migration-statements.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient, type Client, type InArgs, type InStatement } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { createWorkspace, setInboxReadAt } from '../web-poc/lib/db/queries/workspaces.ts';
import { inboxBadgeSource, inboxBadgeStream, type HubSocket, type InboxBadgeSource } from './inbox-badge.ts';

// What the nav-badge stream COSTS per connected tab, measured rather than asserted (#383).
// The stream used to re-read the whole inbox every 10s per tab: 187,855 read queries and
// 1,600,703 rows in 24h of production, to recompute one number ~2,000 times per actual
// change. What is pinned here is the shape that fixes it — a cheap watermark probe that
// only escalates to a full read when something moved — and the counts it produces.

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
  const slowTimers = { keepAliveMs: 60_000, safetyNetMs: 60_000, noticeWindowMs: 0 };

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
      noticeWindowMs: 0,
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
      noticeWindowMs: 0,
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
      noticeWindowMs: 0,
    });
    const frames = await readFrames(stream, 3);
    expect(frames.slice(1)).toEqual([': keep-alive\n\n', ': keep-alive\n\n']);
  });

  test('the safety net still lands a change the hub never reported', async () => {
    const ws = (await createWorkspace(database, { name: 'Lost notice', ownerUserId: USER })).id;
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), fakeHub().socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 15,
      noticeWindowMs: 0,
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
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), null, { keepAliveMs: 60_000, safetyNetMs: 15, noticeWindowMs: 0 });
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

// Coalescing the notice rate (#383 follow-up).
//
// Pushing removed a bound the polling it replaced had for free. A 10s tick cost 8,640
// recomputes a day per tab HOWEVER busy the workspace was; a notice per write makes the
// cost proportional to the WRITE RATE, which nothing caps — several turns settling at
// once, or an agent sending across chats in a loop, multiplies straight into D1, and the
// watermark cannot help because the notified path skips it by design. That is a change in
// cost SHAPE, not just volume.
//
// This codebase already learned this once and then lost it: live presence used to ride
// "the throttled `event: presence` SSE frames" (CONTEXT.md), and #293 moved presence onto
// tldraw sync — which throttles internally — deleting the bespoke transport and taking the
// throttle with it. The lesson left with the code that carried it. This is its second
// instance, so the damping is pinned by tests this time.
const NOTICE = JSON.stringify({ topic: 'inbox' });

/**
 * A source that counts what the stream asks of it, and reports whether two recomputes were
 * ever in flight at once. Every recompute answers a higher count, so each one that reaches
 * the client is observable as a frame.
 */
function countingSource(opts: { delayMs?: number } = {}) {
  const calls: ('poll' | 'push')[] = [];
  let count = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const record = (kind: 'poll' | 'push') => async () => {
    calls.push(kind);
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    inFlight -= 1;
    count += 1;
    return { count, readAt: 0 };
  };
  return {
    source: { poll: record('poll'), push: record('push') } satisfies InboxBadgeSource,
    get pushes() {
      return calls.filter((c) => c === 'push').length;
    },
    get peakInFlight() {
      return peakInFlight;
    },
  };
}

const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('inboxBadgeStream — a burst of notices is coalesced, without losing the last one', () => {
  test('a burst inside the window costs TWO recomputes: the leading one and one trailing', async () => {
    const s = countingSource();
    const hub = fakeHub();
    const stream = inboxBadgeStream(s.source, hub.socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 60_000,
      noticeWindowMs: 40,
    });
    const reader = stream.getReader();
    await reader.read(); // the opening badge (a poll, not a push)

    for (let i = 0; i < 10; i++) hub.emit('message', NOTICE);
    await after(150);

    expect(s.pushes).toBe(2);
    await reader.cancel();
  });

  // The one that matters: dropping this turns a cost fix into a correctness bug — a badge
  // that is silently wrong until the five-minute safety net, which is worse than the volume.
  test('a change arriving mid-window still reaches the client, on the trailing recompute', async () => {
    const ws = (await createWorkspace(database, { name: 'Mid-window', ownerUserId: USER })).id;
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 60_000,
      noticeWindowMs: 40,
    });
    const reader = stream.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toBe('data: {"count":0,"readAt":0}\n\n');

    // The leading notice recomputes immediately and finds nothing new, so it writes no frame.
    hub.emit('message', NOTICE);
    // …and only THEN does the change land, with its notice falling inside the window.
    await conversations.create(database, { sessionId: 's_midwindow', userId: USER, workspaceId: ws });
    hub.emit('message', NOTICE);

    // With a 60s keep-alive and a 60s safety net, the trailing recompute is the only thing
    // in the process that can produce this frame. Suppress it and this read never returns.
    expect(dec.decode((await reader.read()).value)).toBe('data: {"count":1,"readAt":0}\n\n');
    await reader.cancel();
  });

  test('an isolated notice is served on the LEADING edge — the window adds nothing to its latency', async () => {
    const ws = (await createWorkspace(database, { name: 'Isolated', ownerUserId: USER })).id;
    await conversations.create(database, { sessionId: 's_isolated', userId: USER, workspaceId: ws });
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, ws, USER), hub.socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 60_000,
      noticeWindowMs: 2_000,
    });
    const reader = stream.getReader();
    await reader.read(); // the opening badge

    await conversations.close(database, (await conversations.list(database, { workspaceId: ws }))[0]!.id);
    const started = Date.now();
    hub.emit('message', NOTICE);
    const frame = new TextDecoder().decode((await reader.read()).value);

    expect(frame).toBe('data: {"count":0,"readAt":0}\n\n');
    // A two-second window, and the frame is here in a fraction of it: the notice was not
    // made to wait for one.
    expect(Date.now() - started).toBeLessThan(200);
    await reader.cancel();
  });

  test('a sustained storm settles to about one recompute per window, not one per notice', async () => {
    const s = countingSource();
    const hub = fakeHub();
    const windowMs = 40;
    const stream = inboxBadgeStream(s.source, hub.socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 60_000,
      noticeWindowMs: windowMs,
    });
    const reader = stream.getReader();
    await reader.read();

    const storm = 400;
    const ticker = setInterval(() => hub.emit('message', NOTICE), 4); // ~100 notices
    await after(storm);
    clearInterval(ticker);
    await after(windowMs * 2);

    // Ceiling: one per window, plus the leading edge, plus slack for timer jitter.
    expect(s.pushes).toBeLessThanOrEqual(Math.ceil(storm / windowMs) + 2);
    expect(s.pushes).toBeGreaterThan(1); // …and it kept up: this is damping, not muting
    await reader.cancel();
  });

  // Coalescing bounds how OFTEN a recompute starts; it does not by itself stop two from
  // overlapping when one runs long. Overlap is not merely wasteful — a slow leading read
  // resolving after a fast trailing one would write the older count last, and the badge
  // would sit wrong until something else moved.
  test('recomputes never overlap, so a slow one cannot land after a newer one and undo it', async () => {
    const s = countingSource({ delayMs: 30 });
    const hub = fakeHub();
    const stream = inboxBadgeStream(s.source, hub.socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 60_000,
      noticeWindowMs: 5,
    });
    const reader = stream.getReader();
    await reader.read();

    for (let i = 0; i < 8; i++) {
      hub.emit('message', NOTICE);
      await after(8); // each one lands in a fresh window, while the previous read is still running
    }
    await after(120);

    expect(s.peakInFlight).toBe(1);
    await reader.cancel();
  });

  // The measurement, on real rows through the same meter Part 1 used.
  test('MEASUREMENT: a burst of 20 notices reads what two recomputes read, not twenty', async () => {
    const hub = fakeHub();
    const stream = inboxBadgeStream(inboxBadgeSource(database, wsId, USER), hub.socket, {
      keepAliveMs: 60_000,
      safetyNetMs: 60_000,
      noticeWindowMs: 40,
    });
    const reader = stream.getReader();
    await reader.read();

    meter.queries = 0;
    meter.rows = 0;
    for (let i = 0; i < 20; i++) hub.emit('message', NOTICE);
    await after(150);
    const damped = { queries: meter.queries, rows: meter.rows };

    // What the same burst cost before coalescing: one full recompute per notice.
    const undamped = await cost(async () => {
      const bare = inboxBadgeSource(database, wsId, USER);
      for (let i = 0; i < 20; i++) await bare.push();
    });

    console.log(
      `[#383 follow-up] burst of 20 notices — coalesced: ${damped.queries} queries / ${damped.rows} rows; ` +
        `un-coalesced: ${undamped.queries} queries / ${undamped.rows} rows`,
    );
    expect(damped.rows * 5).toBeLessThan(undamped.rows);
    await reader.cancel();
  });
});
