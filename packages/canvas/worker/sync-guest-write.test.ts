// The guest WRITE path (#320), against the real `TLSocketRoom` the Durable Object hosts.
//
// `sync-readonly.test.ts` pins the floor: a guest granted nothing cannot move the
// document. This pins what the grants actually buy, at the same level — the authoritative
// room, over the real wire protocol — because a permission enforced anywhere above the
// room is enforced nowhere (the pad's modules are fetchable by any link holder).
//
// The composition under test is the DO's `webSocketMessage`: assemble, narrow, forward.
// The narrowing itself is unit-tested in `guest-socket-policy.test.ts`; here it has to
// survive contact with a room that validates records and answers pushes.

import { describe, expect, test } from 'bun:test';
import { RecordOpType, getTlsyncProtocolVersion } from '@tldraw/sync-core';

import { guestCapabilities } from '../shared/guest-capabilities.ts';
import { createCanvasTLSchema } from '../src/tl-schema.ts';
import { isInteractOnly, narrowInteractPush } from './guest-socket-policy.ts';
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

const connectMessage = () =>
  JSON.stringify({
    type: 'connect',
    connectRequestId: 'req_1',
    schema: createCanvasTLSchema().serialize(),
    protocolVersion: getTlsyncProtocolVersion(),
    lastServerClock: 0,
  });

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

const shapeOf = (room: ReturnType<typeof roomWithComponent>) =>
  room.getCurrentSnapshot().documents.find((d) => d.state.id === 'shape:c1')?.state as
    | { x: number; props: { data: unknown } }
    | undefined;

/** The Durable Object's `webSocketMessage` for an interact-only session, minus the
 *  chunk assembly (these messages are single-chunk). Keeping it here rather than
 *  reaching into the DO — which needs a `DurableObjectState` — keeps the test at the
 *  room level, where the enforcement has to be true. */
const asInteractOnlyGuest = (room: ReturnType<typeof roomWithComponent>, sessionId: string) => (raw: string) =>
  room.handleSocketMessage(sessionId, JSON.stringify(narrowInteractPush(JSON.parse(raw))));

const dataPush = (n: number) =>
  JSON.stringify({
    type: 'push',
    clientClock: 1,
    diff: { 'shape:c1': [RecordOpType.Patch, { props: [RecordOpType.Patch, { data: [RecordOpType.Put, { n }] }] }] },
  });

describe('a guest granted guest_edit — a first-class writer on the members’ socket', () => {
  test('moves a shape, and the room records the move as the GUEST, not as the container', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    expect(isInteractOnly(guestCapabilities({ guestEdit: true }))).toBe(false);
    // `guest:<sessionId>`: the identity the DO mints per connection, so two guests on one
    // link are two authors. Nothing about this session is the container's.
    room.handleSocketConnect({ sessionId: 'g1', socket: guest.socket, isReadonly: false, meta: { userId: 'guest:g1' } });
    guest.receive(connectMessage());
    await settle();

    guest.receive(
      JSON.stringify({ type: 'push', clientClock: 1, diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, 400] }] } }),
    );
    await settle();

    expect(shapeOf(room)?.x).toBe(400);
    expect(room.getSessions().find((s) => s.sessionId === 'g1')?.meta).toEqual({ userId: 'guest:g1' });
    room.close();
  });
});

describe('a guest granted only guest_interact', () => {
  test('USES the component: a data write commits', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    const send = asInteractOnlyGuest(room, 'g1');
    room.handleSocketConnect({ sessionId: 'g1', socket: guest.socket, isReadonly: false, meta: { userId: 'guest:g1' } });
    send(connectMessage());
    await settle();

    send(dataPush(2));
    await settle();

    // This is the whole point of the default (#320 §6): a link exists to show someone a
    // component, and until now they could watch it but not use it.
    expect(shapeOf(room)?.props.data).toEqual({ n: 2 });
    room.close();
  });

  test('but CANNOT move it — the document is not theirs to edit', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    const send = asInteractOnlyGuest(room, 'g1');
    room.handleSocketConnect({ sessionId: 'g1', socket: guest.socket, isReadonly: false, meta: { userId: 'guest:g1' } });
    send(connectMessage());
    await settle();

    send(JSON.stringify({ type: 'push', clientClock: 1, diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, 400] }] } }));
    await settle();

    expect(shapeOf(room)?.x).toBe(0);
    room.close();
  });

  test('cannot smuggle an edit alongside a legitimate data write', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    const send = asInteractOnlyGuest(room, 'g1');
    room.handleSocketConnect({ sessionId: 'g1', socket: guest.socket, isReadonly: false, meta: { userId: 'guest:g1' } });
    send(connectMessage());
    await settle();

    send(
      JSON.stringify({
        type: 'push',
        clientClock: 1,
        diff: {
          'shape:c1': [RecordOpType.Patch, { props: [RecordOpType.Patch, { data: [RecordOpType.Put, { n: 9 }] }] }],
          'page:page': [RecordOpType.Patch, { name: [RecordOpType.Put, 'pwned'] }],
        },
      }),
    );
    await settle();

    // Neither op landed: a push is all-or-nothing here, so a rejected op cannot be used
    // to launder an allowed one alongside it.
    expect(shapeOf(room)?.props.data).toEqual({ n: 1 });
    expect(room.getCurrentSnapshot().documents.find((d) => d.state.id === 'page:page')?.state).toMatchObject({
      name: 'Page 1',
    });
    room.close();
  });

  test('cannot DELETE the shape they were shown', async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    const send = asInteractOnlyGuest(room, 'g1');
    room.handleSocketConnect({ sessionId: 'g1', socket: guest.socket, isReadonly: false, meta: { userId: 'guest:g1' } });
    send(connectMessage());
    await settle();

    send(JSON.stringify({ type: 'push', clientClock: 1, diff: { 'shape:c1': [RecordOpType.Remove] } }));
    await settle();

    expect(shapeOf(room)).toBeTruthy();
    room.close();
  });

  test("still RECEIVES a member's edits — narrowed writing is not degraded reading", async () => {
    const room = roomWithComponent();
    const guest = fakeSocket();
    const member = fakeSocket();
    const send = asInteractOnlyGuest(room, 'g1');
    room.handleSocketConnect({ sessionId: 'g1', socket: guest.socket, isReadonly: false, meta: { userId: 'guest:g1' } });
    room.handleSocketConnect({ sessionId: 'member', socket: member.socket, meta: { userId: 'u_1' } });
    send(connectMessage());
    member.receive(connectMessage());
    await settle();
    guest.sent.length = 0;

    member.receive(
      JSON.stringify({ type: 'push', clientClock: 1, diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, 77] }] } }),
    );
    await settle();

    expect(shapeOf(room)?.x).toBe(77);
    expect(guest.sent.join('')).toContain('77');
    room.close();
  });
});
