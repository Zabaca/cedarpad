// The guest read path's security core (#294, ADR-0019).
//
// A share link is a capability to READ one canvas. "Read-only" therefore has to be a
// property of the SESSION IN THE ROOM, not of the UI: the pad is served by a vite dev
// server whose modules a guest can already fetch (guest-gate.ts), so anything enforced
// only in the browser is enforced nowhere. These tests drive the REAL `TLSocketRoom` the
// Durable Object hosts, over the real wire protocol, and assert that a read-only
// session's document push is dropped by the server while it still RECEIVES a member's
// edits — which is the whole of what a guest is supposed to be able to do.

import { describe, expect, test } from 'bun:test';
import { RecordOpType, getTlsyncProtocolVersion } from '@tldraw/sync-core';

import { createCanvasTLSchema } from '../src/tl-schema.ts';
import { isReadonlyRequest, SYNC_READONLY_HEADER } from './sync-api.ts';
import { createCanvasSyncRoom } from './sync-room.ts';

const PAGE = { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} } as const;

const COMPONENT = {
  id: 'shape:c1',
  typeName: 'shape',
  type: 'component',
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  parentId: 'page:page',
  isLocked: false,
  opacity: 1,
  meta: {},
  props: { w: 100, h: 80, module: 'KpiBoard', data: { n: 1 }, rev: 1, dataSource: null },
};

/** A `WebSocketMinimal` a test can push into and read back from. */
function fakeSocket() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const sent: string[] = [];
  return {
    sent,
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

function connectMessage() {
  return JSON.stringify({
    type: 'connect',
    connectRequestId: 'req_1',
    schema: createCanvasTLSchema().serialize(),
    protocolVersion: getTlsyncProtocolVersion(),
    lastServerClock: 0,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

function roomWithComponent() {
  return createCanvasSyncRoom({
    initialSnapshot: {
      clock: 1,
      documents: [
        { lastChangedClock: 1, state: PAGE },
        { lastChangedClock: 1, state: COMPONENT },
      ],
    } as never,
  });
}

const dataOf = (room: ReturnType<typeof roomWithComponent>) =>
  (room.getCurrentSnapshot().documents.find((d) => d.state.id === 'shape:c1')?.state as { props: { data: unknown } })
    .props.data;

describe('the read-only decision the Worker hands the room', () => {
  test('is the stamped header, and only the exact value the Worker writes', () => {
    const withHeader = (v: string) => new Request('https://x/', { headers: { [SYNC_READONLY_HEADER]: v } });
    expect(isReadonlyRequest(withHeader('1'))).toBe(true);
    expect(isReadonlyRequest(withHeader('0'))).toBe(false);
    expect(isReadonlyRequest(withHeader('true'))).toBe(false);
    expect(isReadonlyRequest(new Request('https://x/'))).toBe(false);
  });
});

describe('a read-only session in the room (the guest)', () => {
  test('CANNOT write the document — the push is dropped server-side', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    room.handleSocketConnect({ sessionId: 'guest', socket: guest.socket, isReadonly: true, meta: { userId: 'guest:sl_1' } });
    guest.receive(connectMessage());
    await settle();

    guest.receive(
      JSON.stringify({
        type: 'push',
        clientClock: 1,
        diff: { 'shape:c1': [RecordOpType.Patch, { props: [RecordOpType.Patch, { data: [RecordOpType.Put, { n: 666 }] }] }] },
      }),
    );
    await settle();

    // The room still holds what it held. Not "the guest's client hid the change" — the
    // authoritative document never moved.
    expect(dataOf(room)).toEqual({ n: 1 });
    room.close();
  });

  test('cannot DELETE the shape it was shared either', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    room.handleSocketConnect({ sessionId: 'guest', socket: guest.socket, isReadonly: true, meta: { userId: 'guest:sl_1' } });
    guest.receive(connectMessage());
    await settle();

    guest.receive(JSON.stringify({ type: 'push', clientClock: 1, diff: { 'shape:c1': [RecordOpType.Remove] } }));
    await settle();

    expect(room.getCurrentSnapshot().documents.some((d) => d.state.id === 'shape:c1')).toBe(true);
    room.close();
  });

  test("RECEIVES a member's edit — read-only is read-ONLY, not disconnected", async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    const member = fakeSocket();
    room.handleSocketConnect({ sessionId: 'guest', socket: guest.socket, isReadonly: true, meta: { userId: 'guest:sl_1' } });
    room.handleSocketConnect({ sessionId: 'member', socket: member.socket, meta: { userId: 'u_1' } });
    guest.receive(connectMessage());
    member.receive(connectMessage());
    await settle();
    guest.sent.length = 0;

    member.receive(
      JSON.stringify({
        type: 'push',
        clientClock: 1,
        diff: { 'shape:c1': [RecordOpType.Patch, { props: [RecordOpType.Patch, { data: [RecordOpType.Put, { n: 42 }] }] }] },
      }),
    );
    await settle();

    // The member's write landed...
    expect(dataOf(room)).toEqual({ n: 42 });
    // ...and the room pushed it down the guest's socket. This is the acceptance
    // criterion "updates live when a member edits it", at the transport.
    expect(guest.sent.join('')).toContain('42');
    room.close();
  });
});
