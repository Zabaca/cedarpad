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

/** The Durable Object's private admission step, reached from the test (`fetch` needs workerd's WebSocketPair). */
type Admit = (
  ws: FakeSocket,
  p: { sessionId: string; identity: string; readonly: boolean; interactOnly: boolean; guest: boolean; linkId: string | undefined },
) => void;

/** A Durable Object over a real room holding one component shape, plus `connect` for admitting sockets
 *  the way `fetch` does (that path needs workerd's WebSocketPair, which bun does not have). */
function setup() {
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage: fakeStorage(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => void sockets.push(ws),
  };
  const dobj = new CanvasSyncRoom(ctx as never, {} as never) as CanvasSyncRoom & { admit: Admit };
  const room = (dobj as unknown as { room: TLSocketRoom<TLRecord, SyncSessionMeta> }).room;
  // Seed the document through the room's own write path.
  void room.updateStore((store) => {
    store.put(PAGE as never);
    store.put(shape(0) as never);
  });

  const connect = (sessionId: string, opts: { guest?: boolean; interactOnly?: boolean; linkId?: string; beforeConnect?: (ws: FakeSocket) => void } = {}) => {
    const ws = new FakeSocket();
    const userId = opts.guest ? `guest:${sessionId}` : `u_${sessionId}`;
    ws.serializeAttachment({
      sessionId,
      meta: { userId },
      interactOnly: !!opts.interactOnly,
      ...(opts.guest ? { guest: true, linkId: opts.linkId ?? 'sl_1' } : {}),
    });
    // Admitted through the Durable Object's own admission, as `fetch` does after it makes the socket.
    dobj.admit(ws, {
      sessionId,
      identity: userId,
      readonly: false,
      interactOnly: !!opts.interactOnly,
      guest: !!opts.guest,
      linkId: opts.guest ? (opts.linkId ?? 'sl_1') : undefined,
    });
    opts.beforeConnect?.(ws);
    // The client's first message, through the same entry point as every other.
    dobj.webSocketMessage(ws as never, CONNECT);
    return ws;
  };
  // The room batches what it sends one session within a frame (~16ms). A negative assertion has to let a
  // frame pass; a positive one waits only for its condition.
  const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
  const until = async (condition: () => boolean, ms = 1000) => {
    for (const start = Date.now(); !condition() && Date.now() - start < ms; ) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(condition()).toBe(true);
  };
  return { dobj, room, connect, wait, until, sockets, storage: ctx.storage };
}

const heard = (ws: FakeSocket) => JSON.stringify(ws.messages());
const patchPresence = (clientClock: number, patch: Record<string, unknown>) =>
  JSON.stringify({ type: 'push', clientClock, presence: [RecordOpType.Patch, patch] });

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

// #339 follow-up: presence is the room's, so a guest cannot hide from members or dress up as one.
describe('CanvasSyncRoom.webSocketMessage: server-owned presence', () => {
  test('a guest who sends a member\'s id, a stale timestamp, an invisible colour and a name tag is shown as themselves', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    await wait();
    member.sent.length = 0;

    const hostile = { ...presence('Ada'), userId: 'user:u_m', lastActivityTimestamp: 1, color: '#ffffff', chatMessage: 'Maple Street Crew' };
    dobj.webSocketMessage(guest as never, JSON.stringify({ type: 'push', clientClock: 1, presence: [RecordOpType.Put, hostile] }));
    await until(() => heard(member).includes('instance_presence'));

    const told = heard(member);
    expect(told).toContain('"userId":"user:guest:g"');
    expect(told).not.toContain('user:u_m');
    expect(told).not.toContain('"lastActivityTimestamp":1,');
    expect(told).not.toContain('#ffffff');
    expect(told).not.toContain('Maple Street Crew');
    expect(told).toContain('(Guest) Ada');
  });

  test('a patch that rewinds the timestamp, the id, the colour or the chat message is stamped too', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    dobj.webSocketMessage(guest as never, pushPresence('Ada'));
    await wait();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, patchPresence(2, { lastActivityTimestamp: ['put', 1], userId: ['put', 'user:u_m'], color: ['put', 'white'], chatMessage: ['put', 'Maple Street Crew'] }));
    await until(() => heard(member).includes('instance_presence'));

    // tldraw broadcasts the MINIMAL diff against the stored record, which already carries the stamped id,
    // colour and chat message, so what a member hears is the timestamp moving and nothing the guest sent.
    const told = heard(member);
    expect(told).not.toContain('user:u_m');
    expect(told).not.toContain('"white"');
    expect(told).not.toContain('Maple Street Crew');
    expect(told).not.toMatch(/"lastActivityTimestamp":\["put",1\]/);
  });

  test('an honest guest extending their name is shown the longer name, not "Guest"', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    dobj.webSocketMessage(guest as never, pushPresence('(Guest) Ada'));
    await wait();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, patchPresence(2, { userName: ['append', ' Quill', 11] }));
    await until(() => heard(member).includes('Quill'));

    // The member's copy is '(Guest) Ada' and tldraw sends it the same append, so it becomes
    // '(Guest) Ada Quill'. What matters is that it is NOT the bare "Guest" a refused append became.
    expect(heard(member)).toContain('["append"," Quill",11]');
    expect(heard(member)).not.toContain('"Guest"');
  });

  test('a second append builds on the first', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    dobj.webSocketMessage(guest as never, pushPresence('(Guest) Ada'));
    dobj.webSocketMessage(guest as never, patchPresence(2, { userName: ['append', ' Q', 11] }));
    await wait();
    member.sent.length = 0;
    dobj.webSocketMessage(guest as never, patchPresence(3, { userName: ['append', 'uill', 13] }));
    await until(() => heard(member).includes('uill'));
    expect(heard(member)).not.toContain('"Guest"');
  });

  // tldraw keeps a session id across reconnects. A guest who dropped mid-chunk left the assembler
  // half-way; the new socket's connect used to be an error to it and the guest was refused (1008).
  test('a guest who reconnects on the same session id after dropping mid-message is let in', async () => {
    const { dobj, connect, wait } = setup();
    const first = connect('g', { guest: true });
    await wait();
    dobj.webSocketMessage(first as never, '3_half of a chunked mess');

    const again = connect('g', { guest: true });
    await wait();

    expect(again.closed).toBeNull();
    expect(again.messages().some((m) => m.type === 'connect')).toBe(true);
  });

  test('and a member\'s presence is still their own: nothing here touches a member', async () => {
    const { dobj, connect, wait, until } = setup();
    const watcher = connect('w');
    const member = connect('m');
    await wait();
    watcher.sent.length = 0;
    dobj.webSocketMessage(member as never, JSON.stringify({ type: 'push', clientClock: 1, presence: [RecordOpType.Put, { ...presence('Ada'), color: '#ffffff', chatMessage: 'hi' }] }));
    await until(() => heard(watcher).includes('instance_presence'));
    expect(heard(watcher)).toContain('#ffffff');
    expect(heard(watcher)).toContain('"chatMessage":"hi"');
  });
});

describe('CanvasSyncRoom: dropping a socket', () => {
  test('revocation drops by the same path as a protocol break: the room is told, the socket closed 1008', async () => {
    const { dobj, connect, wait } = setup();
    const guest = connect('g', { guest: true, linkId: 'sl_9' });
    const member = connect('m');
    await wait();
    const res = await dobj.fetch(new Request('https://do.test/api/canvas-sync/c1/evict?linkId=sl_9', { headers: { 'x-sync-user': 'u_m' } }));
    expect(res.status).toBe(204);
    expect(guest.closed?.code).toBe(1008);
    expect(member.closed).toBeNull();
  });
});

// Probes C and D of the re-review: editing without being seen.
describe('CanvasSyncRoom.webSocketMessage: a guest cannot edit unseen', () => {
  const move = (clientClock: number, x: number) =>
    JSON.stringify({ type: 'push', clientClock, diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, x] }] } });

  test('a guest that only ever sends document changes still appears to members, marked and stamped', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    await wait();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, move(1, 500));
    await until(() => heard(member).includes('instance_presence'));

    const told = heard(member);
    expect(told).toContain('500');
    expect(told).toContain('user:guest:g');
    expect(told).toContain('"userName":"Guest"');
  });

  test('after one presence put, document-only pushes keep the timestamp fresh', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    dobj.webSocketMessage(guest as never, pushPresence('Ada'));
    await wait();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, move(2, 700));
    await until(() => heard(member).includes('lastActivityTimestamp'));
    expect(heard(member)).toContain('700');
  });

  test('a guest who did present keeps the name they chose when they later send only document changes', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    dobj.webSocketMessage(guest as never, pushPresence('Ada'));
    await wait();
    member.sent.length = 0;
    dobj.webSocketMessage(guest as never, move(2, 300));
    await until(() => heard(member).includes('300'));
    expect(heard(member)).not.toContain('"Guest"');
  });

  // Probes P and P2: the room only accepts presence from a CONNECTED session, so what counts is what the room
  // holds, not what the DO forwarded. A push sent before `connect` is ignored by the room.
  const roomPresenceOf = (d: unknown) =>
    [...(d as { room: { room: { presenceStore: Map<string, { userId: string; userName: string }> } } }).room.room.presenceStore.values()].find(
      (r) => r.userId === 'user:guest:g',
    );

  test('P: a push sent before connect does not make the room think the guest has a record: later edits still show them', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true, beforeConnect: (ws) => dobj.webSocketMessage(ws as never, move(1, 111)) });
    await wait();
    expect(roomPresenceOf(dobj)).toBeUndefined();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, move(2, 222));
    await until(() => roomPresenceOf(dobj) !== undefined);

    expect(heard(member)).toContain('222');
    expect(heard(member)).toContain('user:guest:g');
  });

  test('P2: a presence put sent before connect is ignored by the room, and the guest is still given a record', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true, beforeConnect: (ws) => dobj.webSocketMessage(ws as never, pushPresence('Ada')) });
    await wait();
    expect(roomPresenceOf(dobj)).toBeUndefined();
    member.sent.length = 0;

    dobj.webSocketMessage(guest as never, move(2, 333));
    await until(() => roomPresenceOf(dobj) !== undefined);
    expect(heard(member)).toContain('333');
  });

  // Probes F and H: the room ignores a presence it cannot read and applies the diff anyway.
  test.each([['remove', ['remove']], ['false', false], ['zero', 0], ['empty string', ''], ['unknown op', ['zap', {}]], ['patch null', ['patch', null]], ['patch list', ['patch', []]]])(
    'a hand-written push with presence %s and an edit still shows the guest',
    async (_name, junk) => {
      const { dobj, connect, wait, until } = setup();
      const member = connect('m');
      const guest = connect('g', { guest: true });
      await wait();
      member.sent.length = 0;

      dobj.webSocketMessage(guest as never, JSON.stringify({ type: 'push', clientClock: 1, presence: junk, diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, 600] }] } }));
      await until(() => heard(member).includes('instance_presence'));
      expect(heard(member)).toContain('600');
      expect(heard(member)).toContain('user:guest:g');
    },
  );

  test('after a put, the same junk refreshes the timestamp instead of leaving the guest to go idle', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    dobj.webSocketMessage(guest as never, pushPresence('Ada'));
    await wait();
    member.sent.length = 0;
    dobj.webSocketMessage(guest as never, JSON.stringify({ type: 'push', clientClock: 2, presence: ['patch', null], diff: { 'shape:c1': [RecordOpType.Patch, { x: [RecordOpType.Put, 800] }] } }));
    await until(() => heard(member).includes('lastActivityTimestamp'));
    expect(heard(member)).toContain('800');
  });

  test('the default record sits on the room\'s own page', async () => {
    const { dobj, connect, wait, until } = setup();
    const member = connect('m');
    const guest = connect('g', { guest: true });
    await wait();
    member.sent.length = 0;
    dobj.webSocketMessage(guest as never, move(1, 5));
    await until(() => heard(member).includes('instance_presence'));
    expect(heard(member)).toContain('"currentPageId":"page:page"');
  });

  // Probe J: a wake restores the guest's real record (sync-core keeps it in the session snapshot), so the DO
  // must not forget it exists, or the next cursor patch would replace the named guest with a default.
  describe('hibernation, through the real handleSocketResume', () => {
    const wake = (setupResult: ReturnType<typeof setup>) => {
      const { dobj, sockets, storage } = setupResult;
      for (const ws of sockets) {
        const a = ws.deserializeAttachment() as { sessionId: string };
        ws.serializeAttachment({ ...a, snapshot: (dobj as unknown as { room: TLSocketRoom<TLRecord, SyncSessionMeta> }).room.getSessionSnapshot(a.sessionId) });
      }
      return new CanvasSyncRoom({ storage, getWebSockets: () => sockets, acceptWebSocket: () => {} } as never, {} as never) as CanvasSyncRoom & { room: TLSocketRoom<TLRecord, SyncSessionMeta> };
    };
    const presenceOfGuest = (d: { room: TLSocketRoom<TLRecord, SyncSessionMeta> }) =>
      [...(d.room as unknown as { room: { presenceStore: Map<string, { userId: string; userName: string }> } }).room.presenceStore.values()].find((r) => r.userId === 'user:guest:g');

    test('a guest who had a record keeps it and its name', async () => {
      const setupResult = setup();
      const { dobj, connect, wait } = setupResult;
      const guest = connect('g', { guest: true });
      dobj.webSocketMessage(guest as never, pushPresence('(Guest) Ada'));
      await wait();

      const woken = wake(setupResult);

      expect(presenceOfGuest(woken)?.userName).toBe('(Guest) Ada');
    });

    test('a cursor patch after the wake amends the restored record, not a default one', async () => {
      const setupResult = setup();
      const { dobj, connect, wait } = setupResult;
      const member = connect('m');
      const guest = connect('g', { guest: true });
      dobj.webSocketMessage(guest as never, pushPresence('(Guest) Ada'));
      await wait();
      const woken = wake(setupResult);

      woken.webSocketMessage(guest as never, patchPresence(2, { cursor: [RecordOpType.Put, { x: 300, y: 300, type: 'default', rotation: 0 }] }));
      await wait();

      expect(presenceOfGuest(woken)?.userName).toBe('(Guest) Ada');
      void member;
    });

    test('an append after the wake still extends the name', async () => {
      const setupResult = setup();
      const { dobj, connect, wait } = setupResult;
      const guest = connect('g', { guest: true });
      dobj.webSocketMessage(guest as never, pushPresence('(Guest) Ada'));
      await wait();
      const woken = wake(setupResult);

      woken.webSocketMessage(guest as never, patchPresence(2, { userName: ['append', ' Quill', 11] }));
      await wait();
      expect(presenceOfGuest(woken)?.userName).toBe('(Guest) Ada Quill');
    });

    test('a guest who never had a record has none to keep, so their next edit puts one', async () => {
      const setupResult = setup();
      const { connect, wait } = setupResult;
      const guest = connect('g', { guest: true });
      await wait();

      const woken = wake(setupResult);
      expect(presenceOfGuest(woken)).toBeUndefined();

      woken.webSocketMessage(guest as never, move(1, 5));
      await wait();
      expect(presenceOfGuest(woken)?.userName).toBe('Guest');
    });
  });
});
