import { beforeEach, describe, expect, test } from 'bun:test';

import { mintGuestCookie, GUEST_COOKIE } from './guest-session.ts';
import {
  evictGuestSockets,
  handleSyncUpgrade,
  parseSyncPath,
  resolveSyncGuest,
  SYNC_GUEST_CAPS_HEADER,
  SYNC_GUEST_LINK_HEADER,
  SYNC_READONLY_HEADER,
  SYNC_USER_HEADER,
} from './sync-api.ts';
import { guestCapabilities, readGuestCapabilities } from '../shared/guest-capabilities.ts';
import { syncRoomName } from './sync-room.ts';

// The sync upgrade is the ONE door into a canvas's room, so its gate is the whole security
// story of ADR-0019's server half: no session ⇒ no room, and a session that cannot reach
// canvas Y must not be able to open canvas Y's room by naming it in the path. Both run
// against the real handler; only the reachability lookup (a database round trip) is
// injected. Deliberately NOT `mock.module` — bun's module mocks are process-global, and
// stubbing `access.ts` / the db runtime here corrupts every other worker suite in the run.

/** Only `u_1` on `canvas_x` is reachable; everything else fails closed, like the real one. */
const canReach = async (_env: unknown, canvasId: string, userId: string) =>
  userId === 'u_1' && canvasId === 'canvas_x';

/** Records which DO name the handler resolved, so "one room per canvas" is observable. */
let resolvedNames: string[] = [];
/** The request the handler actually forwarded to the room — where identity and the
 *  read-only decision are stamped, so both are observable from outside. */
let forwarded: Request | null = null;
const env = {
  CANVAS_SYNC: {
    idFromName(name: string) {
      resolvedNames.push(name);
      return { name };
    },
    get(id: { name: string }) {
      return {
        fetch: async (req: Request) => {
          forwarded = req;
          return new Response(`room:${id.name}`, { status: 101 });
        },
      };
    },
  },
} as never;

/** The guest branch's injected resolver: only this canvas's live link resolves. */
const resolveGuest = async (_req: Request, _env: unknown, canvasId: string) =>
  canvasId === 'canvas_x' ? { linkId: 'sl_1', caps: guestCapabilities({}) } : null;
/** …the same, for a link that grants a capability. */
const resolveGuestWith = (grants: Parameters<typeof guestCapabilities>[0]) => async () => ({
  linkId: 'sl_1',
  caps: guestCapabilities(grants),
});
const noGuest = async () => null;

const upgrade = (path: string) =>
  new Request(`https://app.cedarpad.com${path}`, { headers: { upgrade: 'websocket' } });

beforeEach(() => {
  resolvedNames = [];
  forwarded = null;
});

describe('parseSyncPath', () => {
  test('matches the connect route and yields the canvas id', () => {
    expect(parseSyncPath('/api/canvas-sync/canvas_x/connect')).toBe('canvas_x');
  });

  test('ignores everything else', () => {
    expect(parseSyncPath('/api/canvas-sync/canvas_x')).toBeNull();
    expect(parseSyncPath('/api/chat/stream')).toBeNull();
  });
});

describe('handleSyncUpgrade', () => {
  test('rejects an unauthenticated upgrade', async () => {
    const res = await handleSyncUpgrade(upgrade('/api/canvas-sync/canvas_x/connect'), env, 'canvas_x', null, canReach);
    expect(res.status).toBe(401);
    // No Durable Object was even addressed: an anonymous request cannot instantiate a room.
    expect(resolvedNames).toEqual([]);
  });

  test("rejects a user authorized for canvas X opening canvas Y's room", async () => {
    const res = await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_y/connect'),
      env,
      'canvas_y',
      { id: 'u_1' },
      canReach,
    );
    expect(res.status).toBe(403);
    expect(resolvedNames).toEqual([]);
  });

  test('routes an authorized upgrade to the canvas-derived room, deterministically', async () => {
    const path = '/api/canvas-sync/canvas_x/connect';
    const one = await handleSyncUpgrade(upgrade(path), env, 'canvas_x', { id: 'u_1' }, canReach);
    await handleSyncUpgrade(upgrade(path), env, 'canvas_x', { id: 'u_1' }, canReach);
    expect(one.status).toBe(101);
    expect(resolvedNames).toEqual([syncRoomName('canvas_x'), syncRoomName('canvas_x')]);
  });

  test('a member connects WRITABLE: no read-only header is stamped', async () => {
    await handleSyncUpgrade(upgrade('/api/canvas-sync/canvas_x/connect'), env, 'canvas_x', { id: 'u_1' }, canReach, noGuest);
    expect(forwarded?.headers.get(SYNC_USER_HEADER)).toBe('u_1');
    expect(forwarded?.headers.get(SYNC_READONLY_HEADER)).toBeNull();
    // A member is not a guest: the capability header is DELETED, not merely unset, so a
    // member's own connection can never be interpreted as a capability-bounded one.
    expect(forwarded?.headers.get(SYNC_GUEST_CAPS_HEADER)).toBeNull();
  });
});

// The guest branch (#294). A share link is a capability to READ one canvas: it opens the
// same room, identified as the link and marked read-only, and the mark is what the DO
// turns into a session that cannot write.
describe('handleSyncUpgrade — guests', () => {
  test('a guest with no grants connects read-only, and with NO user identity stamped', async () => {
    const res = await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_x/connect'),
      env,
      'canvas_x',
      null,
      canReach,
      resolveGuest,
    );
    expect(res.status).toBe(101);
    expect(resolvedNames).toEqual([syncRoomName('canvas_x')]);
    // #320: identity is per SESSION (`guest:<sessionId>`), and only the Durable Object
    // knows the sessionId, so the Worker stamps none. Two guests on one link must be
    // distinguishable in presence and history; the LINK identity could not do that.
    expect(forwarded?.headers.get(SYNC_USER_HEADER)).toBeNull();
    expect(forwarded?.headers.get(SYNC_READONLY_HEADER)).toBe('1');
    expect(readGuestCapabilities(forwarded?.headers.get(SYNC_GUEST_CAPS_HEADER) ?? null)).toEqual(guestCapabilities({}));
  });

  // The capability set rides the HANDSHAKE (#320 §4): the connection, not a later HTTP
  // call under the container's credential, is the writer. So the socket's writability is
  // decided here, once, from the live link row.
  test('guest_edit makes the socket WRITABLE; the capabilities ride along', async () => {
    await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_x/connect'),
      env,
      'canvas_x',
      null,
      canReach,
      resolveGuestWith({ guestEdit: true }),
    );
    expect(forwarded?.headers.get(SYNC_READONLY_HEADER)).toBeNull();
    expect(readGuestCapabilities(forwarded?.headers.get(SYNC_GUEST_CAPS_HEADER) ?? null)).toMatchObject({
      editCanvas: true,
      interact: false,
    });
  });

  test('guest_interact alone also lifts read-only — the room narrows it, not the handshake', async () => {
    await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_x/connect'),
      env,
      'canvas_x',
      null,
      canReach,
      resolveGuestWith({ guestInteract: true }),
    );
    // Read-only is the protocol's only binary. An interact-only guest must be able to push
    // SOMETHING, so the narrowing to "component data and nothing else" happens per message
    // inside the Durable Object (worker/guest-socket-policy.ts), not here.
    expect(forwarded?.headers.get(SYNC_READONLY_HEADER)).toBeNull();
    expect(readGuestCapabilities(forwarded?.headers.get(SYNC_GUEST_CAPS_HEADER) ?? null)).toMatchObject({
      interact: true,
      editCanvas: false,
    });
  });

  test('a link granting only chat/huddle/source stays read-only on the socket', async () => {
    await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_x/connect'),
      env,
      'canvas_x',
      null,
      canReach,
      resolveGuestWith({ guestChat: true, guestHuddle: true, guestEditSource: true }),
    );
    expect(forwarded?.headers.get(SYNC_READONLY_HEADER)).toBe('1');
  });

  test("a guest cannot open another canvas's room", async () => {
    const res = await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_y/connect'),
      env,
      'canvas_y',
      null,
      canReach,
      resolveGuest,
    );
    expect(res.status).toBe(401);
    expect(resolvedNames).toEqual([]);
  });

  test('a client cannot claim read-only status — or shed it, or its identity, or its capabilities', async () => {
    const spoof = new Request('https://app.cedarpad.com/api/canvas-sync/canvas_x/connect', {
      headers: {
        upgrade: 'websocket',
        [SYNC_READONLY_HEADER]: '0',
        [SYNC_USER_HEADER]: 'u_admin',
        [SYNC_GUEST_CAPS_HEADER]: JSON.stringify(guestCapabilities({ guestEdit: true })),
      },
    });
    await handleSyncUpgrade(spoof, env, 'canvas_x', null, canReach, resolveGuest);
    expect(forwarded?.headers.get(SYNC_READONLY_HEADER)).toBe('1');
    expect(forwarded?.headers.get(SYNC_USER_HEADER)).toBeNull();
    expect(readGuestCapabilities(forwarded?.headers.get(SYNC_GUEST_CAPS_HEADER) ?? null).editCanvas).toBe(false);
    expect(forwarded?.headers.get(SYNC_GUEST_LINK_HEADER)).toBe('sl_1');
  });

  // #320 slice 2: capabilities ride the handshake, so a live connection keeps what it had
  // at connect time. Revoking has to reach it, and the room can only find it if the
  // connection remembers WHICH link let it in.
  test('a guest connection carries its link id; a member connection carries none', async () => {
    await handleSyncUpgrade(upgrade('/api/canvas-sync/canvas_x/connect'), env, 'canvas_x', null, canReach, resolveGuest);
    expect(forwarded?.headers.get(SYNC_GUEST_LINK_HEADER)).toBe('sl_1');
    await handleSyncUpgrade(upgrade('/api/canvas-sync/canvas_x/connect'), env, 'canvas_x', { id: 'u_1' }, canReach, noGuest);
    expect(forwarded?.headers.get(SYNC_GUEST_LINK_HEADER)).toBeNull();
  });
});

// Revocation is a tombstone, which only stops the NEXT connection. Since the capability
// set is established at the handshake, the guest who is ALREADY connected keeps writing —
// which makes revoke meaningless exactly when you reach for it (#320 §5).
describe('evictGuestSockets', () => {
  test("addresses the canvas's own room and asks it to drop that link's connections", async () => {
    await evictGuestSockets(env, 'canvas_x', 'sl_1', 'u_1');
    expect(resolvedNames).toEqual([syncRoomName('canvas_x')]);
    const url = new URL(forwarded?.url ?? '');
    expect(url.pathname.endsWith('/evict')).toBe(true);
    expect(url.searchParams.get('linkId')).toBe('sl_1');
    // The evict door is the MEMBER's, so it is stamped with the revoking member's
    // identity — the DO refuses it otherwise, as it does every other non-socket door.
    expect(forwarded?.headers.get(SYNC_USER_HEADER)).toBe('u_1');
  });
});

// The guest branch's own gate (#294). The LIVE share-link row is the credential — a
// guest is not a user, so `canReachCanvas` has nothing to key on (the same call
// `martsForGuestCanvas` declined for the same reason in #289).
describe('resolveSyncGuest', () => {
  const SECRET = 'test-secret';
  const guestEnv = { BETTER_AUTH_SECRET: SECRET } as never;
  const cookieFor = async (payload: { linkId: string; canvasId: string; shapeId?: string }) =>
    `${GUEST_COOKIE}=${await mintGuestCookie(SECRET, { workspaceId: 'ws_1', guestChat: false, ...payload })}`;
  const req = (cookie: string) =>
    new Request('https://app.cedarpad.com/api/canvas-sync/canvas_x/connect', { headers: { cookie } });
  const liveLink = async (id: string) => (id === 'sl_1' ? { canvasId: 'canvas_x', guestInteract: true } : null);

  test('a live link for this canvas resolves to the link and the capabilities IT grants', async () => {
    const cookie = await cookieFor({ linkId: 'sl_1', canvasId: 'canvas_x' });
    expect(await resolveSyncGuest(req(cookie), guestEnv, 'canvas_x', liveLink)).toEqual({
      linkId: 'sl_1',
      caps: guestCapabilities({ guestInteract: true }),
    });
  });

  // The LIVE row is the source, not the cookie: a cookie minted before a downgrade must
  // not keep the capability it was minted with. (Revocation already worked this way.)
  test('capabilities come from the live row, not from the cookie that carried them', async () => {
    const cookie = await cookieFor({ linkId: 'sl_1', canvasId: 'canvas_x' });
    const downgraded = async () => ({ canvasId: 'canvas_x', guestInteract: false, guestEdit: false });
    expect((await resolveSyncGuest(req(cookie), guestEnv, 'canvas_x', downgraded))?.caps.interact).toBe(false);
  });

  test('a component-scoped link (#221) resolves the same way — the narrowing is the shape, not the room', async () => {
    const cookie = await cookieFor({ linkId: 'sl_1', canvasId: 'canvas_x', shapeId: 'shape:c1' });
    expect((await resolveSyncGuest(req(cookie), guestEnv, 'canvas_x', liveLink))?.linkId).toBe('sl_1');
  });

  test('a REVOKED link resolves to nothing, even with a validly signed cookie', async () => {
    const cookie = await cookieFor({ linkId: 'sl_revoked', canvasId: 'canvas_x' });
    expect(await resolveSyncGuest(req(cookie), guestEnv, 'canvas_x', liveLink)).toBeNull();
  });

  test('a guest of another canvas cannot resolve for this one', async () => {
    const cookie = await cookieFor({ linkId: 'sl_1', canvasId: 'canvas_other' });
    expect(await resolveSyncGuest(req(cookie), guestEnv, 'canvas_x', liveLink)).toBeNull();
  });

  test('a forged cookie resolves to nothing', async () => {
    expect(await resolveSyncGuest(req(`${GUEST_COOKIE}=eyJsaW5rSWQiOiJzbF8xIn0.bogus`), guestEnv, 'canvas_x', liveLink)).toBeNull();
  });

  test('no cookie at all resolves to nothing', async () => {
    expect(await resolveSyncGuest(req(''), guestEnv, 'canvas_x', liveLink)).toBeNull();
  });
});
