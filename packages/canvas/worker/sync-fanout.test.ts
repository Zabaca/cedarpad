// The fan-out regression test (ADR-0019, issue #296).
//
// The bug this exists to keep dead: the hand-rolled canvas sync serialized the ENTIRE
// canvas to EVERY client on every single-shape edit — O(shapes × clients) per edit.
//
// METHODOLOGY, and it is the whole point of this file. The spike's other performance
// arms produced pure noise because they asserted absolute thresholds (frame times),
// which a loaded machine failed even for sync-free baselines. So:
//
//   - We measure BYTES ON THE WIRE. That is a discrete, machine-independent quantity;
//     it is identical on an idle laptop and a thrashing CI box.
//   - We assert on the SHAPE OF THE CURVE — flatness — never on an absolute byte count.
//     A number like "28.6 bytes per edit" rots the moment a prop is added to a shape.
//     "10× the document costs the same bytes" does not rot; it is the actual invariant.
//
// Bytes are read from `TLSocketRoom`'s `onBeforeSendMessage` hook, which reports the
// exact string the room hands to each session's socket, attributed by session id.

import { describe, expect, test } from 'bun:test';
import { RecordOpType, getTlsyncProtocolVersion } from '@tldraw/sync-core';

import { createCanvasTLSchema } from '../src/tl-schema.ts';
import { createCanvasSyncRoom } from './sync-room.ts';

/**
 * How much drift we tolerate before calling the curve non-flat.
 *
 * This is a tolerance on a RATIO, not on a byte count — that distinction is the point.
 * The independent variable moves 10× (50 → 500 shapes) or 2.5× (2 → 5 clients); a
 * regression to full-state broadcast moves the dependent variable by the same factor.
 * 1.5 leaves room for incidental encoding wobble (a longer record id, a bigger clock)
 * while being nowhere near the 10× a real regression produces.
 */
const FLATNESS_TOLERANCE = 1.5;

const PAGE = {
  id: 'page:page',
  typeName: 'page',
  name: 'Page 1',
  index: 'a1',
  meta: {},
} as const;

function componentShape(id: string, x = 0) {
  return {
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'component',
    x,
    y: 0,
    rotation: 0,
    index: 'a1',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 100, h: 80, module: 'hello', data: {}, rev: 1, dataSource: null },
  };
}

/** A `WebSocketMinimal` that lets a test push messages in. Bytes are counted by the
 *  room's own hook, not here, so this socket deliberately discards what it is sent. */
function fakeSocket() {
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    receive(data: string) {
      listeners.message?.({ data });
    },
    socket: {
      readyState: 1,
      send() {},
      close() {},
      addEventListener(type: string, listener: (e: unknown) => void) {
        listeners[type] = listener;
      },
      removeEventListener(type: string) {
        delete listeners[type];
      },
    },
  };
}

/** The client half of the sync handshake, hand-rolled — the room is the thing under test. */
function connectMessage() {
  return JSON.stringify({
    type: 'connect',
    connectRequestId: 'req_1',
    schema: createCanvasTLSchema().serialize(),
    protocolVersion: getTlsyncProtocolVersion(),
    lastServerClock: 0,
  });
}

/** `TLSyncRoom` sends the first patch immediately and debounces the rest into a `data`
 *  batch. Long enough to have flushed anything outstanding, short enough for CI. */
const FLUSH_MS = 100;
const settle = () => new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

interface FanOut {
  /** Bytes the room sent back to the client that made the edit (the push ack). */
  author: number;
  /** Bytes the room sent to each OTHER client, averaged. `null` when there are none. */
  perObserver: number | null;
  /** Bytes the room sent to everyone, for the edit. */
  total: number;
}

/**
 * Connect `clients` sessions to a room holding `shapes` shapes, then move ONE shape by
 * one client and report the server→client bytes that edit cost. Handshake traffic is
 * excluded: the counters are zeroed after every client has settled.
 */
async function measureFanOut(shapes: number, clients: number): Promise<FanOut> {
  const bytesBySession = new Map<string, number>();
  const room = createCanvasSyncRoom({
    initialSnapshot: {
      clock: 1,
      documents: [
        { lastChangedClock: 1, state: PAGE },
        ...Array.from({ length: shapes }, (_, i) => ({
          lastChangedClock: 1,
          state: componentShape(`c${i}`, i),
        })),
        // hand-built records, as in sync-room.test.ts
      ] as any,
    },
    onBeforeSendMessage({ sessionId, stringified }) {
      const before = bytesBySession.get(sessionId) ?? 0;
      bytesBySession.set(sessionId, before + Buffer.byteLength(stringified, 'utf8'));
    },
  });

  const sockets = Array.from({ length: clients }, (_, i) => {
    const client = fakeSocket();
    room.handleSocketConnect({ sessionId: `s${i}`, socket: client.socket, meta: { userId: `u${i}` } });
    client.receive(connectMessage());
    return client;
  });

  await settle();
  bytesBySession.clear();

  // One shape moves. This is the atom the original bug multiplied by the whole document.
  sockets[0].receive(
    JSON.stringify({
      type: 'push',
      clientClock: 1,
      diff: { 'shape:c0': [RecordOpType.Patch, { x: [RecordOpType.Put, 999] }] },
    }),
  );
  await settle();

  // The edit must actually have landed — a room that silently rejected the push would
  // read as perfectly flat at zero bytes, which is a passing test measuring nothing.
  const moved = room
    .getCurrentSnapshot()
    .documents.find((d) => d.state.id === 'shape:c0')?.state as { x?: number } | undefined;
  expect(moved?.x).toBe(999);

  room.close();

  const author = bytesBySession.get('s0') ?? 0;
  const observers = [...bytesBySession].filter(([id]) => id !== 's0').map(([, n]) => n);
  expect(author).toBeGreaterThan(0);
  for (const n of observers) expect(n).toBeGreaterThan(0);

  return {
    author,
    perObserver: observers.length ? observers.reduce((a, b) => a + b, 0) / observers.length : null,
    total: author + observers.reduce((a, b) => a + b, 0),
  };
}

const CLIENT_COUNTS = [1, 2, 5] as const;
const DOC_SIZES = [50, 500] as const;

describe('fan-out: bytes per single-shape edit', () => {
  // The measurement grid is built once and shared by the assertions below, so the whole
  // suite costs six rooms rather than six per assertion.
  const grid = new Map<string, FanOut>();
  const key = (shapes: number, clients: number) => `${shapes}/${clients}`;

  test('measures the grid: 1, 2 and 5 clients at 50 and 500 shapes', async () => {
    for (const shapes of DOC_SIZES) {
      for (const clients of CLIENT_COUNTS) {
        const result = await measureFanOut(shapes, clients);
        grid.set(key(shapes, clients), result);
        console.log(
          `  ${String(shapes).padStart(3)} shapes, ${clients} client(s): ` +
            `total ${result.total} B, author ${result.author} B, ` +
            `per observer ${result.perObserver ?? '—'} B`,
        );
      }
    }
    expect(grid.size).toBe(DOC_SIZES.length * CLIENT_COUNTS.length);
  }, 30_000);

  // THE regression. Full-state broadcast means a 10× document costs 10× the bytes.
  test('is flat in document size: 10× the shapes does not cost more bytes', () => {
    for (const clients of CLIENT_COUNTS) {
      const small = grid.get(key(50, clients));
      const large = grid.get(key(500, clients));
      expect(small && large).toBeTruthy();
      // non-null: asserted above
      expect(large!.total).toBeLessThanOrEqual(small!.total * FLATNESS_TOLERANCE);
    }
  });

  // The other half of O(shapes × clients): per-client cost must not grow with the crowd.
  // Total bytes necessarily grow linearly with clients — everyone needs the edit — so the
  // invariant is the PER-CLIENT cost, which a full-state broadcast leaves flat but which
  // any "send everyone everything again for each new peer" scheme blows up.
  test('is flat in client count: each observer costs the same at 5 clients as at 2', () => {
    for (const shapes of DOC_SIZES) {
      const two = grid.get(key(shapes, 2))?.perObserver;
      const five = grid.get(key(shapes, 5))?.perObserver;
      expect(two).toBeGreaterThan(0);
      expect(five).toBeGreaterThan(0);
      // non-null: asserted above
      expect(five!).toBeLessThanOrEqual(two! * FLATNESS_TOLERANCE);
    }
  });

  // The push ack is a fixed-size receipt, not a redelivery of the document. Checked
  // separately because a regression could reintroduce full state on the author's socket
  // alone (the old code echoed the new state back to the writer) and the observer
  // assertions would not see it.
  test('is flat in document size for the author ack too', () => {
    for (const clients of CLIENT_COUNTS) {
      const small = grid.get(key(50, clients))?.author;
      const large = grid.get(key(500, clients))?.author;
      expect(small).toBeGreaterThan(0);
      // non-null: asserted above
      expect(large!).toBeLessThanOrEqual(small! * FLATNESS_TOLERANCE);
    }
  });
});
