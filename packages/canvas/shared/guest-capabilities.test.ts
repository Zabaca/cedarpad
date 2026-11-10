import { describe, expect, test } from 'bun:test';

import { GuestCapabilities, guestCapabilities, NO_GUEST_CAPABILITIES, readGuestCapabilities } from './guest-capabilities.ts';

// #320: the ONE place a share link becomes a decision. Three doors derive from this —
// the edge HTTP gate (worker/guest-gate.ts), the sync handshake (worker/sync-api.ts) and
// the bridge (server/bridge.ts). #297 happened because those three each decided for
// themselves and drifted; this table is what they now share, so it is the spec.

const link = {
  guestChat: false,
  guestHuddle: false,
  guestInteract: false,
  guestEdit: false,
  guestEditSource: false,
};

describe('guestCapabilities — one grant per capability, nothing implied', () => {
  test('a link with nothing granted can do nothing', () => {
    expect(guestCapabilities(link)).toEqual({
      interact: false,
      editCanvas: false,
      editSource: false,
      chat: false,
      huddle: false,
    });
  });

  test('each grant lights exactly its own capability — no level, no cascade', () => {
    expect(guestCapabilities({ ...link, guestInteract: true }).interact).toBe(true);
    expect(guestCapabilities({ ...link, guestInteract: true }).editCanvas).toBe(false);
    // Editing the document does NOT imply the right to author source, and vice versa:
    // they are different kinds of risk (shapes vs. JS in a member's browser).
    expect(guestCapabilities({ ...link, guestEdit: true })).toMatchObject({ editCanvas: true, editSource: false });
    expect(guestCapabilities({ ...link, guestEditSource: true })).toMatchObject({ editCanvas: false, editSource: true });
    expect(guestCapabilities({ ...link, guestChat: true }).chat).toBe(true);
    expect(guestCapabilities({ ...link, guestHuddle: true }).huddle).toBe(true);
  });

  // Pre-#320 rows (and pre-#320 cookies) carry none of the three booleans. They must not
  // read as granted — default-deny survives the absence of the column, and the DB default
  // + migration backfill are what actually turn interact on for a real row.
  test('absent grants are DENIED, never assumed', () => {
    expect(guestCapabilities({ guestChat: false })).toEqual(NO_GUEST_CAPABILITIES);
  });
});

// PRD #221: a component-scoped link shares an artifact, not a conversation. That is a
// property of the LINK, so it belongs here rather than in each door's own conditional.
describe('guestCapabilities — component-scoped links (#221)', () => {
  test('chat is denied even when the row grants it', () => {
    const caps = guestCapabilities({ ...link, guestChat: true, guestInteract: true, shapeId: 'shape:c1' });
    expect(caps.chat).toBe(false);
    expect(caps.interact).toBe(true);
  });
});

// The capabilities cross two process boundaries (edge → bridge, edge → Durable Object),
// so they are a zod contract parsed on both sides (CLAUDE.md §7) rather than a header
// each reader interprets for itself.
describe('the wire contract', () => {
  test('round-trips through the header encoding', () => {
    const caps = guestCapabilities({ ...link, guestInteract: true, guestEditSource: true });
    expect(readGuestCapabilities(JSON.stringify(caps))).toEqual(caps);
  });

  test('a missing, malformed or partial value reads as NO capabilities — never as trust', () => {
    expect(readGuestCapabilities(null)).toEqual(NO_GUEST_CAPABILITIES);
    expect(readGuestCapabilities('not json')).toEqual(NO_GUEST_CAPABILITIES);
    expect(readGuestCapabilities('{"editCanvas":true}')).toEqual(NO_GUEST_CAPABILITIES);
  });

  test('the schema rejects extra keys rather than passing them through', () => {
    expect(GuestCapabilities.safeParse({ ...NO_GUEST_CAPABILITIES, admin: true }).success).toBe(false);
  });
});
