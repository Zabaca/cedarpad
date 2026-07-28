import { describe, expect, test } from 'bun:test';
import { RecordOpType, getTlsyncProtocolVersion } from '@tldraw/sync-core';

import { createCanvasTLSchema } from '../src/tl-schema.ts';
import { createCanvasSyncRoom, syncRoomName } from './sync-room.ts';

/** A `WebSocketMinimal` that records what the room sent it and lets a test push messages in. */
function fakeSocket() {
  const sent: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    sent,
    messages: () => sent.map((s) => JSON.parse(s) as Record<string, unknown>),
    receive(data: string) {
      listeners.message?.({ data });
    },
    socket: {
      readyState: 1,
      send(data: string) {
        sent.push(data);
      },
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
function connectMessage(lastServerClock = 0) {
  return JSON.stringify({
    type: 'connect',
    connectRequestId: 'req_1',
    schema: createCanvasTLSchema().serialize(),
    protocolVersion: getTlsyncProtocolVersion(),
    lastServerClock,
  });
}

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

// ADR-0019: exactly one TLSocketRoom per canvas, globally. The DO id is that guarantee,
// so the derivation from canvas id must be total and deterministic — a canvas that
// resolved to two different DO names would be hosted twice, and the two copies would
// diverge silently.
describe('syncRoomName', () => {
  test('is deterministic for a canvas id', () => {
    expect(syncRoomName('canvas_abc')).toBe(syncRoomName('canvas_abc'));
  });

  test('is distinct across canvases', () => {
    expect(syncRoomName('canvas_abc')).not.toBe(syncRoomName('canvas_xyz'));
  });
});

// The tracer bullet: one client connects to a room built from the SHARED schema factory
// and gets the document back. Everything else in this slice hangs off this path.
describe('createCanvasSyncRoom', () => {
  test('serves the document to a connecting client', () => {
    const room = createCanvasSyncRoom({
      initialSnapshot: {
        clock: 1,
        documents: [
          { lastChangedClock: 1, state: PAGE },
          { lastChangedClock: 1, state: componentShape('c1') },
        ],
      },
    });
    const client = fakeSocket();
    room.handleSocketConnect({ sessionId: 's1', socket: client.socket, meta: { userId: 'u_1' } });
    client.receive(connectMessage());

    const connect = client.messages().find((m) => m.type === 'connect');
    expect(connect).toBeDefined();
    expect(JSON.stringify(connect)).toContain('shape:c1');
  });

  // Acceptance: two clients in one room; an edit from one arrives at the other. This is
  // the whole point of hosting a SINGLE room per canvas.
  test('fans an edit out from one client to the other', () => {
    const room = createCanvasSyncRoom({
      initialSnapshot: { clock: 1, documents: [{ lastChangedClock: 1, state: PAGE }] },
    });
    const a = fakeSocket();
    const b = fakeSocket();
    room.handleSocketConnect({ sessionId: 'a', socket: a.socket, meta: { userId: 'u_1' } });
    a.receive(connectMessage());
    room.handleSocketConnect({ sessionId: 'b', socket: b.socket, meta: { userId: 'u_2' } });
    b.receive(connectMessage());
    b.sent.length = 0;

    a.receive(
      JSON.stringify({
        type: 'push',
        clientClock: 1,
        diff: { 'shape:c1': [RecordOpType.Put, componentShape('c1', 42)] },
      }),
    );

    expect(JSON.stringify(b.messages())).toContain('shape:c1');
    expect(room.getCurrentSnapshot().documents.some((d) => d.state.id === 'shape:c1')).toBe(true);
  });
});
