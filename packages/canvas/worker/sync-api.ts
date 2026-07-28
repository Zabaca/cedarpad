import type { Bindings } from '../web-poc/worker/context.ts';
import { resolveCanvasWorkspace } from './access.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { syncRoomName } from './sync-room.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { readGuestSession } from './guest-session.ts';
import { getActiveShareLink } from '../web-poc/lib/db/queries/share-links.ts';

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

/**
 * The GUEST branch of this door (#294). A share link is a capability to *read* one
 * canvas, so a guest opens the same room — as the link, read-only.
 *
 * `canReachCanvas` is deliberately not used: it is user-keyed and a guest is not a user.
 * The live share-link row IS the guest's gate, re-read every request so revoking a link
 * kills its connections' ability to reconnect. This mirrors `martsForGuestCanvas`
 * (#289) — the same convention, the same `guest:<linkId>` identity, one door over.
 *
 * Returns the room identity, or null when this request is not a live guest of THIS
 * canvas. The canvas comes from the path, and the cookie names its own canvas: a guest
 * of canvas X naming canvas Y in the path resolves to null.
 */
export async function resolveSyncGuest(
  request: Request,
  env: Env,
  canvasId: string,
  /** Injected so the branch is testable without a database; production has no second one. */
  getLink?: (linkId: string) => Promise<{ canvasId: string } | null>,
): Promise<string | null> {
  if (!env.BETTER_AUTH_SECRET) return null;
  const guest = await readGuestSession(request.headers.get('cookie'), env.BETTER_AUTH_SECRET);
  if (!guest || guest.canvasId !== canvasId) return null;
  const lookup =
    getLink ?? ((id: string) => getActiveShareLink(createDbForWorker(env as unknown as Bindings), id));
  const live = await lookup(guest.linkId);
  if (!live || live.canvasId !== canvasId) return null;
  return `guest:${guest.linkId}`;
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
  resolveGuest: (request: Request, env: Env, canvasId: string) => Promise<string | null> = resolveSyncGuest,
): Promise<Response> {
  if (!user) {
    const guestId = await resolveGuest(request, env, canvasId);
    if (!guestId) return new Response('unauthorized', { status: 401 });
    return forwardToRoom(request, env, canvasId, guestId, true);
  }
  if (!(await canReach(env, canvasId, user.id))) {
    return new Response('forbidden', { status: 403 });
  }
  return forwardToRoom(request, env, canvasId, user.id, false);
}

/** The room trusts its caller for identity AND for the read-only decision: the DO is
 *  reachable only through this handler, so both headers are stamped here — and the
 *  read-only one is *always* written or deleted, never left as the client sent it. */
function forwardToRoom(request: Request, env: Env, canvasId: string, identity: string, readonly: boolean): Promise<Response> {
  const id = env.CANVAS_SYNC.idFromName(syncRoomName(canvasId));
  const forwarded = new Request(request);
  forwarded.headers.set(SYNC_USER_HEADER, identity);
  if (readonly) forwarded.headers.set(SYNC_READONLY_HEADER, '1');
  else forwarded.headers.delete(SYNC_READONLY_HEADER);
  return env.CANVAS_SYNC.get(id).fetch(forwarded);
}

/** Set by `handleSyncUpgrade` after authorization; read by the DO. Never client-supplied. */
export const SYNC_USER_HEADER = 'x-sync-user';

/** `'1'` = this session may not write the document (#294). Set/cleared by
 *  `handleSyncUpgrade`, read by the DO; a client-sent value is always overwritten. */
export const SYNC_READONLY_HEADER = 'x-sync-readonly';

/** The DO's half of that contract: one reader, so the two sides cannot drift on what
 *  counts as read-only. Anything but the exact value this module writes is writable —
 *  which is safe because the Worker always writes or deletes the header. */
export function isReadonlyRequest(request: Request): boolean {
  return request.headers.get(SYNC_READONLY_HEADER) === '1';
}
