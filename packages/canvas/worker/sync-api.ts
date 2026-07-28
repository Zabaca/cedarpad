import type { Bindings } from '../web-poc/worker/context.ts';
import { resolveCanvasWorkspace } from './access.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { syncRoomName } from './sync-room.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { readGuestSession } from './guest-session.ts';
import { getActiveShareLink } from '../web-poc/lib/db/queries/share-links.ts';
import { guestCapabilities, type GuestCapabilities, type GuestGrants } from '../shared/guest-capabilities.ts';

// The ONE door into a canvas's tldraw sync room (ADR-0019). It SELF-GATES rather than
// sitting behind `decideGate`'s deny branch, for the same reason `/mcp` does: that branch
// answers with the login HTML at 200, which is meaningless to a WebSocket client. A
// refused upgrade must be a status code.

/** `/api/canvas-sync/:canvasId/connect` → the canvas id, else null. */
const SYNC_ROUTE = /^\/api\/canvas-sync\/([^/]+)\/connect$/;

export function parseSyncPath(pathname: string): string | null {
  return SYNC_ROUTE.exec(pathname)?.[1] ?? null;
}

/** May this user reach this canvas? `resolveCanvasWorkspace` is the existing composition
 *  seam (worker/access.ts): workspace membership AND ADR-0016 visibility, failing closed. */
export async function canReachCanvas(env: Env, canvasId: string, userId: string): Promise<boolean> {
  const db = createDbForWorker(env as unknown as Bindings);
  return !!(await resolveCanvasWorkspace(db, canvasId, userId));
}

/** What a resolved guest brings to the handshake: which link let them in, and what that
 *  link permits. The identity is NOT here — it is per session (`guest:<sessionId>`) and
 *  only the Durable Object knows the sessionId (#320). */
export interface SyncGuest {
  linkId: string;
  caps: GuestCapabilities;
}

/**
 * The GUEST branch of this door (#294, capabilities added in #320). A share link is a
 * capability for one canvas, so a guest opens the same room — with whatever that link
 * grants, established here at connect time.
 *
 * `canReachCanvas` is deliberately not used: it is user-keyed and a guest is not a user.
 * The live share-link row IS the guest's gate, re-read every request so revoking a link
 * kills its connections' ability to reconnect. It is also the source of the CAPABILITIES:
 * the cookie carries a snapshot of the grants at mint time, and a downgraded link must
 * not keep what it was minted with, exactly as a revoked one does not.
 *
 * Returns null when this request is not a live guest of THIS canvas. The canvas comes
 * from the path, and the cookie names its own canvas: a guest of canvas X naming canvas Y
 * in the path resolves to null.
 */
export async function resolveSyncGuest(
  request: Request,
  env: Env,
  canvasId: string,
  /** Injected so the branch is testable without a database; production has no second one. */
  getLink?: (linkId: string) => Promise<({ canvasId: string } & GuestGrants) | null>,
): Promise<SyncGuest | null> {
  if (!env.BETTER_AUTH_SECRET) return null;
  const guest = await readGuestSession(request.headers.get('cookie'), env.BETTER_AUTH_SECRET);
  if (!guest || guest.canvasId !== canvasId) return null;
  const lookup =
    getLink ?? ((id: string) => getActiveShareLink(createDbForWorker(env as unknown as Bindings), id));
  const live = await lookup(guest.linkId);
  if (!live || live.canvasId !== canvasId) return null;
  // The component-scoped narrowing is the COOKIE's (the link row carries it too, but the
  // cookie is what pins this browser to that shape) — merged in so `guestCapabilities`
  // sees the whole link.
  return { linkId: guest.linkId, caps: guestCapabilities({ ...live, shapeId: live.shapeId ?? guest.shapeId }) };
}

/**
 * Authorize the upgrade and hand the request to the canvas's room.
 *
 * Three rejections, all load-bearing:
 *   - neither a member session nor a live guest link ⇒ 401, decided before any DO is
 *     addressed, so an anonymous request can never even instantiate a room;
 *   - a session that cannot reach this canvas ⇒ 403. The canvas comes from the PATH, so
 *     naming someone else's canvas is exactly what this check refuses — there is no
 *     ambient "current canvas" to fall back to;
 *   - a guest whose link is not live, or is for another canvas ⇒ 401, same as anonymous.
 *
 * The DO id derives from the canvas id alone (`syncRoomName` → `idFromName`), which is
 * what makes "exactly one room per canvas, globally" true.
 */
export async function handleSyncUpgrade(
  request: Request,
  env: Env,
  canvasId: string,
  user: GateUser | null,
  /** The reachability check, injected so the gate is testable without a database.
   *  Production always uses the default — there is no second implementation. */
  canReach: (env: Env, canvasId: string, userId: string) => Promise<boolean> = canReachCanvas,
  /** The guest branch, injected for the same reason. */
  resolveGuest: (request: Request, env: Env, canvasId: string) => Promise<SyncGuest | null> = resolveSyncGuest,
): Promise<Response> {
  if (!user) {
    const guest = await resolveGuest(request, env, canvasId);
    if (!guest) return new Response('unauthorized', { status: 401 });
    // #320: a guest who may interact or edit is a first-class WRITER on this socket. The
    // protocol's only binary is read-only, so it answers "may this session push anything
    // at all"; an interact-only session is narrowed per message inside the DO
    // (worker/guest-socket-policy.ts). Everything else about the session is the same.
    return forwardToRoom(request, env, canvasId, null, !(guest.caps.editCanvas || guest.caps.interact), guest.caps);
  }
  if (!(await canReach(env, canvasId, user.id))) {
    return new Response('forbidden', { status: 403 });
  }
  return forwardToRoom(request, env, canvasId, user.id, false, null);
}

/** The room trusts its caller for identity, for the read-only decision AND for the guest
 *  capability set: the DO is reachable only through this handler, so all three headers are
 *  stamped here — and each is *always* written or deleted, never left as the client sent
 *  it. A guest carries NO user header: their identity is `guest:<sessionId>`, and only the
 *  DO knows the sessionId (#320). */
function forwardToRoom(
  request: Request,
  env: Env,
  canvasId: string,
  identity: string | null,
  readonly: boolean,
  caps: GuestCapabilities | null,
): Promise<Response> {
  const id = env.CANVAS_SYNC.idFromName(syncRoomName(canvasId));
  const forwarded = new Request(request);
  if (identity) forwarded.headers.set(SYNC_USER_HEADER, identity);
  else forwarded.headers.delete(SYNC_USER_HEADER);
  if (readonly) forwarded.headers.set(SYNC_READONLY_HEADER, '1');
  else forwarded.headers.delete(SYNC_READONLY_HEADER);
  if (caps) forwarded.headers.set(SYNC_GUEST_CAPS_HEADER, JSON.stringify(caps));
  else forwarded.headers.delete(SYNC_GUEST_CAPS_HEADER);
  return env.CANVAS_SYNC.get(id).fetch(forwarded);
}

/** Set by `handleSyncUpgrade` after authorization; read by the DO. Never client-supplied. */
export const SYNC_USER_HEADER = 'x-sync-user';

/** `'1'` = this session may not write the document (#294). Set/cleared by
 *  `handleSyncUpgrade`, read by the DO; a client-sent value is always overwritten. */
export const SYNC_READONLY_HEADER = 'x-sync-readonly';

/** The connection's guest capability set, JSON-encoded (#320). PRESENT ⟺ this connection
 *  is a guest's — a member's is deleted, so the DO cannot mistake one for the other.
 *  Set/cleared by `handleSyncUpgrade`, parsed in the DO with `readGuestCapabilities`. */
export const SYNC_GUEST_CAPS_HEADER = 'x-sync-guest-caps';

/** The DO's half of that contract: one reader, so the two sides cannot drift on what
 *  counts as read-only. Anything but the exact value this module writes is writable —
 *  which is safe because the Worker always writes or deletes the header. */
export function isReadonlyRequest(request: Request): boolean {
  return request.headers.get(SYNC_READONLY_HEADER) === '1';
}
