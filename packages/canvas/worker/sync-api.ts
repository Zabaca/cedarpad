import type { Bindings } from '../web-poc/worker/context.ts';
import { resolveCanvasWorkspace } from './access.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { syncRoomName } from './sync-room.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';

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
async function canReachCanvas(env: Env, canvasId: string, userId: string): Promise<boolean> {
  const db = createDbForWorker(env as unknown as Bindings);
  return !!(await resolveCanvasWorkspace(db, canvasId, userId));
}

/**
 * Authorize the upgrade and hand the request to the canvas's room.
 *
 * Two rejections, both load-bearing:
 *   - no session ⇒ 401, decided before any DO is addressed, so an anonymous request can
 *     never even instantiate a room;
 *   - a session that cannot reach this canvas ⇒ 403. The canvas comes from the PATH, so
 *     naming someone else's canvas is exactly what this check refuses — there is no
 *     ambient "current canvas" to fall back to.
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
): Promise<Response> {
  if (!user) return new Response('unauthorized', { status: 401 });
  if (!(await canReach(env, canvasId, user.id))) {
    return new Response('forbidden', { status: 403 });
  }
  const id = env.CANVAS_SYNC.idFromName(syncRoomName(canvasId));
  // The room trusts its caller for identity: the DO is reachable only through this
  // handler, so the userId is stamped here and the client can never supply it.
  const forwarded = new Request(request);
  forwarded.headers.set(SYNC_USER_HEADER, user.id);
  return env.CANVAS_SYNC.get(id).fetch(forwarded);
}

/** Set by `handleSyncUpgrade` after authorization; read by the DO. Never client-supplied. */
export const SYNC_USER_HEADER = 'x-sync-user';
