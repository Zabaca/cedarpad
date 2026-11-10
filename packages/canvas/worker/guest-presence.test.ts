import { describe, expect, test } from 'bun:test';

import { InstancePresenceRecordType } from '@tldraw/tlschema';

import { GUEST_BARE_NAME, GUEST_PALETTE } from '../shared/guest-mark.ts';
import { applyGuestPolicy, stampGuestPresence, type GuestPresenceContext } from './guest-socket-policy.ts';

// #339: what a member sees of a guest (the name, the colour, whether they are there at all) is the
// room's to decide, not the client's. A guest who can choose how they look can choose not to be
// noticed, and noticing is what revocation depends on (#320). The name rules themselves are tested
// with `shared/guest-mark.ts`; the Durable Object's wiring in `canvas-sync-do-guest.test.ts`.

const ctx = (over: Partial<GuestPresenceContext> = {}): GuestPresenceContext => ({ identity: 'guest:s1', now: 1_700_000_000_000, hasPresence: true, ...over });
const push = (presence: unknown, extra: Record<string, unknown> = {}) => ({ type: 'push', clientClock: 1, presence, ...extra });
const presenceOf = (m: unknown) => (m as { presence: [string, Record<string, unknown>] }).presence;
const stamped = (presence: unknown, c: GuestPresenceContext = ctx()) => stampGuestPresence(push(presence), c);

describe('a presence PUT: every field a member sees is the room\'s', () => {
  const hostile = {
    id: 'instance_presence:x',
    userName: 'Ada',
    userId: 'user:a-members-id',
    lastActivityTimestamp: 1,
    color: '#ffffff',
    chatMessage: 'Maple Street Crew',
    cursor: { x: 1, y: 2 },
  };

  test('name marked, timestamp the room\'s clock, id the connection\'s, colour from the palette, chat message empty', () => {
    const { message, userName } = stamped(['put', hostile]);
    const record = presenceOf(message)[1];
    expect(record.userName).toBe('(Guest) Ada');
    expect(record.lastActivityTimestamp).toBe(1_700_000_000_000);
    expect(record.userId).toBe('user:guest:s1');
    expect(GUEST_PALETTE as readonly string[]).toContain(record.color as string);
    expect(record.chatMessage).toBe('');
    expect(userName).toBe('(Guest) Ada');
  });

  test('what the client is left with: the cursor, the camera and the rest, untouched', () => {
    const record = presenceOf(stamped(['put', hostile]).message)[1];
    expect(record.cursor).toEqual({ x: 1, y: 2 });
    expect(record.id).toBe('instance_presence:x');
  });

  test('fields the client left out are filled in, so a bare record is still owned', () => {
    const record = presenceOf(stamped(['put', { id: 'instance_presence:x' }]).message)[1];
    expect(record).toMatchObject({ userName: 'Guest', userId: 'user:guest:s1', lastActivityTimestamp: 1_700_000_000_000, chatMessage: '' });
  });

  test('an invalid or hidden colour never survives: white, nothing, a non-string, not a colour', () => {
    for (const color of ['#ffffff', 'white', '', 42, null, 'url(javascript:x)', 'not a colour']) {
      const record = presenceOf(stamped(['put', { ...hostile, color }]).message)[1];
      expect(GUEST_PALETTE as readonly string[], String(color)).toContain(record.color as string);
    }
  });

  test('a connection keeps one colour, and different connections can differ', () => {
    const a = presenceOf(stamped(['put', hostile], ctx({ identity: 'guest:a' })).message)[1].color;
    expect(presenceOf(stamped(['put', hostile], ctx({ identity: 'guest:a' })).message)[1].color).toBe(a);
    const colours = new Set(Array.from({ length: 40 }, (_, i) => presenceOf(stamped(['put', hostile], ctx({ identity: `guest:${i}` })).message)[1].color));
    expect(colours.size).toBeGreaterThan(1);
  });

  test('the document diff and every other field of the push are carried through', () => {
    const diff = { 'shape:c1': ['patch', { props: ['patch', { data: ['put', { n: 2 }] }] }] };
    const { message } = stampGuestPresence(push(['put', hostile], { diff }), ctx());
    expect(message).toMatchObject({ type: 'push', clientClock: 1, diff });
  });
});

describe('a presence PATCH is stamped like the put it amends', () => {
  test('every presence push counts as activity: the room\'s timestamp is on every patch', () => {
    const { message, userName } = stamped(['patch', { cursor: ['put', { x: 5 }] }]);
    expect(presenceOf(message)[1]).toEqual({ cursor: ['put', { x: 5 }], lastActivityTimestamp: ['put', 1_700_000_000_000] });
    expect(userName).toBeUndefined();
  });

  test('a patch that tries to age itself out gets the room\'s clock instead', () => {
    expect(presenceOf(stamped(['patch', { lastActivityTimestamp: ['put', 1] }]).message)[1].lastActivityTimestamp).toEqual(['put', 1_700_000_000_000]);
  });

  test('a patch of userId, color or chatMessage is replaced, never forwarded', () => {
    const patch = presenceOf(stamped(['patch', { userId: ['put', 'user:a-members-id'], color: ['put', '#ffffff'], chatMessage: ['put', 'Maple Street Crew'] }]).message)[1];
    expect(patch.userId).toEqual(['put', 'user:guest:s1']);
    expect(GUEST_PALETTE as readonly string[]).toContain((patch.color as [string, string])[1]);
    expect(patch.chatMessage).toEqual(['put', '']);
  });

  test('a patch that renames the guest is marked', () => {
    const { message, userName } = stamped(['patch', { userName: ['put', 'Admin'] }]);
    expect(presenceOf(message)[1].userName).toEqual(['put', '(Guest) Admin']);
    expect(userName).toBe('(Guest) Admin');
  });

  test('a delete of the name becomes the bare "Guest"', () => {
    expect(presenceOf(stamped(['patch', { userName: ['delete'] }]).message)[1].userName).toEqual(['put', GUEST_BARE_NAME]);
  });
});

// What a browser sends as its guest types: tldraw's diff of '(Guest) Ada' to '(Guest) Ada Quill'.
describe('an honest guest extending their name', () => {
  test('an append at the end of the name last forwarded is applied to it', () => {
    const { message, userName } = stamped(['patch', { userName: ['append', ' Quill', 11] }], ctx({ lastName: '(Guest) Ada' }));
    expect(presenceOf(message)[1].userName).toEqual(['put', '(Guest) Ada Quill']);
    expect(userName).toBe('(Guest) Ada Quill');
  });

  test('and again, from the name that left behind', () => {
    const first = stamped(['patch', { userName: ['append', ' Q', 11] }], ctx({ lastName: '(Guest) Ada' })).userName!;
    expect(stamped(['patch', { userName: ['append', 'uill', first.length] }], ctx({ lastName: first })).userName).toBe('(Guest) Ada Quill');
  });

  test('an append that does not start where the name ends, or with nothing to extend, is the bare "Guest"', () => {
    expect(stamped(['patch', { userName: ['append', ' Quill', 3] }], ctx({ lastName: '(Guest) Ada' })).userName).toBe(GUEST_BARE_NAME);
    expect(stamped(['patch', { userName: ['append', ' Quill', 11] }]).userName).toBe(GUEST_BARE_NAME);
    expect(stamped(['patch', { userName: ['append', 5, 11] }], ctx({ lastName: '(Guest) Ada' })).userName).toBe(GUEST_BARE_NAME);
  });

  test('extending past the cap is capped, not refused', () => {
    const last = `(Guest) ${'x'.repeat(40)}`;
    expect(stamped(['patch', { userName: ['append', 'more', last.length] }], ctx({ lastName: last })).userName).toBe(last);
  });
});

describe('a push with no presence still counts as activity, and gives a guest a record to be seen by', () => {
  const docOnly = { type: 'push', clientClock: 1, diff: { 'shape:c1': ['patch', { x: ['put', 500] }] } };

  test('a guest with a record: the document-only push carries the room\'s timestamp as a presence patch', () => {
    const { message } = stampGuestPresence(docOnly, ctx({ hasPresence: true }));
    expect(presenceOf(message)).toEqual(['patch', { lastActivityTimestamp: ['put', 1_700_000_000_000] }]);
    expect(message).toMatchObject({ diff: docOnly.diff });
  });

  test('a guest with NO record yet gets one, stamped, so members see who is editing', () => {
    const { message, userName } = stampGuestPresence(docOnly, ctx({ hasPresence: false }));
    const [op, record] = presenceOf(message);
    expect(op).toBe('put');
    expect(record).toMatchObject({ typeName: 'instance_presence', userName: 'Guest', userId: 'user:guest:s1', lastActivityTimestamp: 1_700_000_000_000, chatMessage: '' });
    expect(GUEST_PALETTE as readonly string[]).toContain(record.color as string);
    expect(userName).toBe('Guest');
  });

  test('a patch sent before any put (nothing to patch) becomes that first put', () => {
    const { message } = stampGuestPresence(push(['patch', { cursor: ['put', { x: 1 }] }]), ctx({ hasPresence: false }));
    expect(presenceOf(message)[0]).toBe('put');
  });

});

describe('what is not a push is left alone', () => {
  test('messages that are not pushes are untouched', () => {
    for (const msg of [{ type: 'connect', connectRequestId: 'r' }, { type: 'ping' }]) {
      expect(stampGuestPresence(msg, ctx())).toEqual({ message: msg });
    }
  });

  // The room ignores a presence it cannot read and still applies the push's document diff, so a hand-written
  // push with one would edit unseen. Anything that is not a well-formed put or patch is treated as MISSING.
  const malformed = ['x', 7, 0, false, true, '', null, [], ['remove'], ['zap', {}], ['put'], ['put', 'not-a-record'], ['put', null], ['put', []], ['patch', 'nope'], ['patch', null], ['patch', []], ['patch'], { 0: 'put' }];

  test('a malformed presence is treated as missing: a timestamp patch for a guest with a record', () => {
    for (const presence of malformed) {
      const { message } = stampGuestPresence(push(presence, { diff: { 'shape:c1': ['patch', {}] } }), ctx({ hasPresence: true }));
      expect(presenceOf(message), JSON.stringify(presence)).toEqual(['patch', { lastActivityTimestamp: ['put', 1_700_000_000_000] }]);
      expect(message).toMatchObject({ diff: { 'shape:c1': ['patch', {}] } });
    }
  });

  test('a malformed presence from a guest with no record yet is the default put, so they are still seen', () => {
    for (const presence of malformed) {
      const { message } = stampGuestPresence(push(presence, { diff: {} }), ctx({ hasPresence: false }));
      expect(presenceOf(message)[0], JSON.stringify(presence)).toBe('put');
    }
  });

  test('and it never throws', () => {
    for (const presence of malformed) {
      expect(() => stampGuestPresence(push(presence), ctx()), JSON.stringify(presence)).not.toThrow();
    }
  });

  test('the page is looked up only when a default record is built', () => {
    let lookups = 0;
    const pageId = () => (lookups++, 'page:second');
    stampGuestPresence(push(undefined), ctx({ hasPresence: true, pageId }));
    stampGuestPresence(push(['put', { userName: 'Ada' }]), ctx({ hasPresence: true, pageId }));
    stampGuestPresence(push(['patch', { cursor: ['put', {}] }]), ctx({ hasPresence: true, pageId }));
    stampGuestPresence(push(undefined), ctx({ hasPresence: false, pageId }));
    expect(lookups).toBe(1);
  });

  test('the default record is a full, valid presence record', () => {
    const record = presenceOf(stampGuestPresence(push(undefined), ctx({ hasPresence: false })).message)[1];
    expect(InstancePresenceRecordType.isInstance(record)).toBe(true);
    expect(() => InstancePresenceRecordType.validate(record)).not.toThrow();
  });

  test('the default record sits on the room\'s current page when it is told one', () => {
    const { message } = stampGuestPresence(push(undefined), ctx({ hasPresence: false, pageId: () => 'page:second' }));
    expect(presenceOf(message)[1].currentPageId).toBe('page:second');
    expect(presenceOf(stampGuestPresence(push(undefined), ctx({ hasPresence: false })).message)[1].currentPageId).toBe('page:page');
  });
});

describe('applyGuestPolicy', () => {
  test('stamps presence after narrowing the document diff of an interact-only guest', () => {
    const { message } = applyGuestPolicy(
      push(['put', { userName: 'Ada' }], { diff: { 'shape:c1': ['patch', { x: ['put', 400] }] } }),
      { ...ctx(), interactOnly: true },
    );
    expect(message).not.toHaveProperty('diff');
    expect(presenceOf(message)[1]!.userName).toBe('(Guest) Ada');
  });

  test('stamps presence for a guest who may edit, and leaves their document diff alone', () => {
    const diff = { 'shape:c1': ['patch', { x: ['put', 400] }] };
    const { message } = applyGuestPolicy(push(['put', { userName: 'Ada' }], { diff }), { ...ctx(), interactOnly: false });
    expect(message).toMatchObject({ diff });
    expect(presenceOf(message)[1]!.userName).toBe('(Guest) Ada');
  });
});
