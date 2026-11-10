import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chunk, getTlsyncProtocolVersion, RecordOpType, type TLSocketRoom } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import { createCanvasTLSchema } from '../src/tl-schema.ts';
import { CanvasSyncRoom } from './canvas-sync-do.ts';
import type { SyncSessionMeta } from './sync-room.ts';

// The Durable Object's own wiring of the guest policy (#339, #320): `webSocketMessage` is
// where a guest's messages are read, narrowed and stamped, and where a message the policy
// cannot read must be refused rather than passed on. The policy functions are tested on their
// own in guest-presence.test.ts and guest-socket-policy.test.ts; this drives the class itself,
// over a real room, with a SQLite-backed stand-in for the Durable Object's storage.

/** The two calls `DurableObjectSqliteSyncWrapper` makes on `ctx.storage`, over bun:sqlite. */
function fakeStorage() {
  const db = new Database(':memory:');
  return {
    sql: {
      exec(sql: string, ...bindings: unknown[]) {
        const rows = bindings.length === 0 && !/^\s*(select|pragma)/i.test(sql) ? (db.exec(sql), []) : db.prepare(sql).all(...(bindings as never[]));
        return Object.assign(rows, { toArray: () => rows });
      },
    },
    transactionSync: <T>(cb: () => T): T => db.transaction(cb)(),
  };
}

/** A hibernatable socket: what the room sees (`send`, `close`) and what the DO sees (the attachment). */
class FakeSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readyState = 1;
  private attachment: unknown = null;
  private listeners: Record<string, (e: unknown) => void> = {};
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (e: unknown) => void) {
    this.listeners[type] = listener;
  }
  removeEventListener(type: string) {
    delete this.listeners[type];
  }
  serializeAttachment(a: unknown) {
    this.attachment = a;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  messages() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const PAGE = { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} };
const shape = (x: number) => ({
  id: 'shape:c1',
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
});

const CONNECT = JSON.stringify({
  type: 'connect',
  connectRequestId: 'req_1',
  schema: createCanvasTLSchema().serialize(),
  protocolVersion: getTlsyncProtocolVersion(),
  lastServerClock: 0,
});

const presence = (userName: string) => ({
  id: 'instance_presence:x',
  typeName: 'instance_presence',
  userId: 'user:x',
  userName,
  lastActivityTimestamp: 1,
  color: '#ff0000',
  camera: { x: 0, y: 0, z: 1 },
  cursor: { x: 10, y: 20, type: 'default', rotation: 0 },
  screenBounds: { x: 0, y: 0, w: 1024, h: 768 },
  followingUserId: null,
  brush: null,
  scribbles: [],
  selectedShapeIds: [],
  currentPageId: 'page:page',
  chatMessage: '',
  meta: {},
});

const pushPresence = (userName: string) => JSON.stringify({ type: 'push', clientClock: 1, presence: [RecordOpType.Put, presence(userName)] });
const pushMove = (x: number) =>
  JSON.stringify({ type: 'push', clientClock: 2, diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, x] }] } });

/** A Durable Object over a real room holding one component shape, plus `connect` for admitting sockets
 *  the way `fetch` does (that path needs workerd's WebSocketPair, which bun does not have). */
function setup() {
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage: fakeStorage(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => void sockets.push(ws),
  };
  const dobj = new CanvasSyncRoom(ctx as never, {} as never);
  const room = (dobj as unknown as { room: TLSocketRoom<TLRecord, SyncSessionMeta> }).room;
  // Seed the document through the room's own write path.
  void room.updateStore((store) => {
    store.put(PAGE as never);
    store.put(shape(0) as never);
  });

  const connect = (sessionId: string, opts: { guest?: boolean; interactOnly?: boolean; linkId?: string } = {}) => {
    const ws = new FakeSocket();
    const userId = opts.guest ? `guest:${sessionId}` : `u_${sessionId}`;
    ws.serializeAttachment({
      sessionId,
      meta: { userId },
      interactOnly: !!opts.interactOnly,
      ...(opts.guest ? { guest: true, linkId: opts.linkId ?? 'sl_1' } : {}),
    });
    sockets.push(ws);
    room.handleSocketConnect({ sessionId, socket: ws as never, isReadonly: false, meta: { userId } });
    // The client's first message, through the same entry point as every other.
    dobj.webSocketMessage(ws as never, CONNECT);
    return ws;
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 60));
  return { dobj, room, connect, wait };
}

const shapeX = (room: TLSocketRoom<TLRecord, SyncSessionMeta>) =>
  (room.getCurrentSnapshot().documents.find((d) => d.state.id === 'shape:c1')?.state as { x: number }).x;

describe('CanvasSyncRoom.webSocketMessage, for a guest', () => {
  test("a guest's unmarked presence reaches a member marked", async () => {
    const { dobj, connect, wait } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    await wait();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, pushPresence('Ada'));
    await wait();

    const told = JSON.stringify(member.messages());
    expect(told).toContain('(Guest) Ada');
    expect(told).not.toContain('"Ada"');
  });

  test('a member keeps whatever name they chose: only guests are stamped', async () => {
    const { dobj, connect, wait } = setup();
    const watcher = connect('w');
    const member = connect('m');
    await wait();
    watcher.sent.length = 0;

    dobj.webSocketMessage(member as never, pushPresence('Ada'));
    await wait();

    expect(JSON.stringify(watcher.messages())).toContain('"userName":"Ada"');
  });

  test('a message split into chunks is reassembled, stamped and delivered once', async () => {
    const { dobj, connect, wait } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    await wait();
    member.sent.length = 0;

    const parts = chunk(pushPresence('Ada'), 40);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) dobj.webSocketMessage(guest as never, part);
    await wait();

    expect(guest.closed).toBeNull();
    expect(JSON.stringify(member.messages())).toContain('(Guest) Ada');
  });

  // The bypass: our assembler and the room's are separate. A chunk header leaves ours mid-message,
  // so the complete push that follows is an error to it and was handed on raw, where the room's own
  // idle assembler accepted it: unmarked, and un-narrowed.
  test('a chunk header followed by a whole push does not reach the room: the guest is dropped', async () => {
    const { dobj, connect, wait } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    await wait();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, '1_x');
    dobj.webSocketMessage(guest as never, pushPresence('James'));
    await wait();

    expect(JSON.stringify(member.messages())).not.toContain('"James"');
    expect(JSON.stringify(member.messages())).not.toContain('James');
    expect(guest.closed?.code).toBe(1008);
  });

  test('the same trick cannot move a shape for a guest who may only interact', async () => {
    const { dobj, room, connect, wait } = setup();
    const guest = connect('g', { guest: true, interactOnly: true });
    await wait();

    dobj.webSocketMessage(guest as never, '1_x');
    dobj.webSocketMessage(guest as never, pushMove(400));
    await wait();

    expect(shapeX(room)).toBe(0);
    expect(guest.closed?.code).toBe(1008);
  });

  test('and an interact-only guest\'s plain move is narrowed away, as before', async () => {
    const { dobj, room, connect, wait } = setup();
    const guest = connect('g', { guest: true, interactOnly: true });
    await wait();

    dobj.webSocketMessage(guest as never, pushMove(400));
    await wait();

    expect(shapeX(room)).toBe(0);
    expect(guest.closed).toBeNull();
  });

  test('a message that opens like JSON and is not is refused, and does not throw', async () => {
    const { dobj, connect, wait } = setup();
    const guest = connect('g', { guest: true });
    await wait();

    expect(() => dobj.webSocketMessage(guest as never, '{ not json')).not.toThrow();
    expect(guest.closed?.code).toBe(1008);
  });

  test('a chunk that is not a chunk is refused', async () => {
    const { dobj, connect, wait } = setup();
    const guest = connect('g', { guest: true });
    await wait();

    dobj.webSocketMessage(guest as never, 'hello');
    expect(guest.closed?.code).toBe(1008);
  });

  test('a dropped guest is out of the room: a later message from its session does nothing', async () => {
    const { dobj, room, connect, wait } = setup();
    const guest = connect('g', { guest: true });
    await wait();
    dobj.webSocketMessage(guest as never, 'hello');
    expect(guest.closed?.code).toBe(1008);

    expect(() => dobj.webSocketMessage(guest as never, pushMove(400))).not.toThrow();
    await wait();
    expect(shapeX(room)).toBe(0);
  });

  test('a guest who may edit still edits: the policy does not touch their document diff', async () => {
    const { dobj, room, connect, wait } = setup();
    const guest = connect('g', { guest: true });
    await wait();

    dobj.webSocketMessage(guest as never, pushMove(400));
    await wait();

    expect(shapeX(room)).toBe(400);
  });
});
