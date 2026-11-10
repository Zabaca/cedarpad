import { describe, expect, test } from 'bun:test';
import { RecordOpType, getTlsyncProtocolVersion } from '@tldraw/sync-core';

import { createCanvasTLSchema } from '../src/tl-schema.ts';
import { applyGuestPolicy, GUEST_SUFFIX, markGuestName, markGuestPresence } from './guest-socket-policy.ts';
import { createCanvasSyncRoom } from './sync-room.ts';

// #339: the "(Guest)" badge is what lets a member notice an outsider (revocation is a manual
// call, #320). The browser used to set it, so a guest who sent their presence without it
// appeared as an ordinary collaborator. The room now stamps it on the way in.

const push = (presence: unknown, extra: Record<string, unknown> = {}) => ({ type: 'push', clientClock: 1, presence, ...extra });
const presenceOf = (m: unknown) => (m as { presence: [string, Record<string, unknown>] }).presence;

describe('markGuestName', () => {
  test('appends the mark once', () => {
    expect(markGuestName('Ada')).toBe(`Ada${GUEST_SUFFIX}`);
  });

  test('keeps a mark the client already added, so a well-behaved browser is not doubled', () => {
    expect(markGuestName('Ada (Guest)')).toBe('Ada (Guest)');
  });

  test('trims, so whitespace cannot dodge or double the mark', () => {
    expect(markGuestName('  Ada  ')).toBe('Ada (Guest)');
    expect(markGuestName('Ada (Guest)  ')).toBe('Ada (Guest)');
  });

  test('a missing, blank, non-string or already-bare name is the bare "Guest"', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, [], 'Guest']) {
      expect(markGuestName(bad), String(bad)).toBe('Guest');
    }
  });

  test('a name that merely contains or fakes the mark is still marked', () => {
    expect(markGuestName('(Guest) Ada')).toBe('(Guest) Ada (Guest)');
    expect(markGuestName('Ada(Guest)')).toBe('Ada(Guest) (Guest)');
    expect(markGuestName('Ada (guest)')).toBe('Ada (guest) (Guest)');
  });
});

describe('markGuestPresence', () => {
  test('a presence PUT with no mark gets one', () => {
    const out = markGuestPresence(push(['put', { id: 'instance_presence:x', userName: 'Ada', cursor: { x: 1 } }]));
    expect(presenceOf(out)[1]).toEqual({ id: 'instance_presence:x', userName: 'Ada (Guest)', cursor: { x: 1 } });
  });

  test('a presence PUT with no name at all is the marked "Guest"', () => {
    expect(presenceOf(markGuestPresence(push(['put', { id: 'instance_presence:x' }])))[1]!.userName).toBe('Guest');
  });

  test('a presence PATCH that renames the guest is marked', () => {
    const out = markGuestPresence(push(['patch', { userName: ['put', 'Admin'], cursor: ['put', {}] }]));
    expect(presenceOf(out)[1]).toEqual({ userName: ['put', 'Admin (Guest)'], cursor: ['put', {}] });
  });

  test('a presence PATCH that removes or appends to the name becomes the bare "Guest"', () => {
    for (const op of [['delete'], ['append', 'x', 0]]) {
      expect(presenceOf(markGuestPresence(push(['patch', { userName: op }])))[1]).toEqual({ userName: ['put', 'Guest'] });
    }
  });

  test('a PATCH that does not touch the name is returned as it came', () => {
    const msg = push(['patch', { cursor: ['put', { x: 5 }] }]);
    expect(markGuestPresence(msg)).toEqual(msg);
  });

  test('the document diff and every other field of the push are carried through', () => {
    const diff = { 'shape:c1': ['patch', { props: ['patch', { data: ['put', { n: 2 }] }] }] };
    const out = markGuestPresence(push(['put', { userName: 'Ada' }], { diff }));
    expect(out).toMatchObject({ type: 'push', clientClock: 1, diff });
  });

  test('messages that are not pushes, and pushes with no presence, are untouched', () => {
    for (const msg of [{ type: 'connect', connectRequestId: 'r' }, { type: 'ping' }, { type: 'push', clientClock: 1, diff: {} }]) {
      expect(markGuestPresence(msg)).toEqual(msg);
    }
  });

  test('a malformed presence is passed on for the room to refuse, never throws', () => {
    for (const presence of ['x', 7, null, [], ['put'], ['put', 'not-a-record'], ['patch', 'nope'], ['weird', {}]]) {
      expect(() => markGuestPresence(push(presence))).not.toThrow();
    }
  });
});

describe('applyGuestPolicy', () => {
  test('stamps the badge on an interact-only guest after narrowing the document diff', () => {
    const out = applyGuestPolicy(
      push(['put', { userName: 'Ada' }], { diff: { 'shape:c1': ['patch', { x: ['put', 400] }] } }),
      { interactOnly: true },
    );
    expect(out).not.toHaveProperty('diff');
    expect(presenceOf(out)[1]!.userName).toBe('Ada (Guest)');
  });

  test('stamps the badge on a guest who may edit, and leaves their document diff alone', () => {
    const diff = { 'shape:c1': ['patch', { x: ['put', 400] }] };
    const out = applyGuestPolicy(push(['put', { userName: 'Ada' }], { diff }), { interactOnly: false });
    expect(out).toMatchObject({ diff });
    expect(presenceOf(out)[1]!.userName).toBe('Ada (Guest)');
  });
});

// The whole path through a real room: what a MEMBER's socket is told about a guest.
describe('a member sees a guest who tried to drop the badge as a guest anyway', () => {
  function fakeSocket() {
    const sent: string[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    return {
      sent,
      messages: () => sent.map((s) => JSON.parse(s) as Record<string, unknown>),
      receive: (data: string) => listeners.message?.({ data }),
      socket: {
        readyState: 1,
        send: (data: string) => void sent.push(data),
        close() {},
        addEventListener: (type: string, listener: (e: unknown) => void) => void (listeners[type] = listener),
        removeEventListener: (type: string) => void delete listeners[type],
      },
    };
  }
  const connect = JSON.stringify({
    type: 'connect',
    connectRequestId: 'req_1',
    schema: createCanvasTLSchema().serialize(),
    protocolVersion: getTlsyncProtocolVersion(),
    lastServerClock: 0,
  });
  const presenceRecord = (userName: string) => ({
    id: 'instance_presence:guest',
    typeName: 'instance_presence',
    userId: 'user:guest',
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

  function memberAndGuest() {
    const room = createCanvasSyncRoom({
      initialSnapshot: {
        clock: 1,
        documents: [{ lastChangedClock: 1, state: { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} } }],
      },
    });
    const member = fakeSocket();
    const guest = fakeSocket();
    room.handleSocketConnect({ sessionId: 'm', socket: member.socket, meta: { userId: 'u_1' } });
    member.receive(connect);
    room.handleSocketConnect({ sessionId: 'g', socket: guest.socket, meta: { userId: 'guest:g' } });
    guest.receive(connect);
    member.sent.length = 0;
    return { room, member, guest };
  }

  test('the unmarked presence a hostile guest sends reaches the member marked', () => {
    const { room, member } = memberAndGuest();
    const hostile = push([RecordOpType.Put, presenceRecord('Ada')]);

    // What the Durable Object does with every guest message before the room sees it.
    room.handleSocketMessage('g', JSON.stringify(applyGuestPolicy(hostile, { interactOnly: false })));

    const told = JSON.stringify(member.messages());
    expect(told).toContain('Ada (Guest)');
    expect(told).not.toContain('"userName":"Ada"');
  });

  test('without the policy the badge is whatever the guest chose: the hole this closes', () => {
    const { room, member } = memberAndGuest();
    room.handleSocketMessage('g', JSON.stringify(push([RecordOpType.Put, presenceRecord('Ada')])));
    expect(JSON.stringify(member.messages())).toContain('"userName":"Ada"');
  });

  test('a later patch that tries to rename the guest to an unmarked name is marked too', async () => {
    const { room, member } = memberAndGuest();
    room.handleSocketMessage('g', JSON.stringify(applyGuestPolicy(push([RecordOpType.Put, presenceRecord('Ada (Guest)')]), { interactOnly: false })));
    // The room batches what it sends one session within a frame (~16ms); wait it out so the
    // second update is its own delivery.
    await new Promise((resolve) => setTimeout(resolve, 60));
    member.sent.length = 0;

    const rename = push([RecordOpType.Patch, { userName: [RecordOpType.Put, 'James'] }], { clientClock: 2 });
    room.handleSocketMessage('g', JSON.stringify(applyGuestPolicy(rename, { interactOnly: false })));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const told = JSON.stringify(member.messages());
    expect(told).toContain('James (Guest)');
    expect(told).not.toContain('"James"');
  });
});
