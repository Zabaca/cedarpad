// The migration door onto a canvas's sync room (ADR-0019, #295) — the third door beside
// `/connect`'s WebSocket upgrade and `/mutate`'s agent write path, and shaped like them:
// it SELF-GATES ahead of `decideGate`, because that branch answers with the login HTML at
// status 200 and a script needs a real status code.
//
//   GET  /api/canvas-sync/:canvasId/snapshot → the room's current snapshot
//   POST /api/canvas-sync/:canvasId/snapshot → replace it (409 unless empty or ?force=1)
//
// TWO DELIBERATE DIFFERENCES FROM `/mutate`, both load-bearing:
//
//   1. The gate is ADMIN, not `canReachCanvas`. A POST here replaces a canvas's whole
//      document in one call — a migration operation, not something a workspace member
//      should be able to do to their own canvas by URL. It is also not a stricter version
//      of the same check: requiring reachability TOO would break the migration, because
//      the operator running it need not be a member of every workspace that owns a canvas,
//      and those canvases would 403 while the run otherwise looked successful.
//
//   2. The body is NOT parsed here before the Durable Object is addressed. `/mutate`
//      parses first so a malformed payload costs no DO wake and unknown keys never travel;
//      neither applies to a snapshot. It has no narrow schema to strip against — the
//      payload IS the document — so buffering and re-serializing several megabytes in the
//      Worker would double peak memory to buy nothing. The receiving side still parses at
//      the boundary (`handleSnapshotRequest`, worker/snapshot-io.ts), which is what
//      CLAUDE.md §7 actually asks for.

import { eq } from 'drizzle-orm';

import {
  CANVAS_SNAPSHOT_LABEL,
  OPERATOR_PRINCIPAL,
  operatorRejection,
  presentedBearer,
  verifyCanvasOperatorToken,
} from '../shared/canvas-operator-token.ts';
import { user as userTable } from '../web-poc/lib/db/schema.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { SYNC_USER_HEADER } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

const SNAPSHOT_ROUTE = /^\/api\/canvas-sync\/([^/]+)\/snapshot$/;

/** `/api/canvas-sync/:canvasId/snapshot` → the canvas id, else null. */
export function parseCanvasSnapshotPath(pathname: string): string | null {
  return SNAPSHOT_ROUTE.exec(pathname)?.[1] ?? null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Better Auth's admin role — the same `user.role === 'admin'` the waitlist view gates on
 *  (worker/admin.ts, ADR-0014). No signup path sets it. */
async function isAdminUser(env: Env, userId: string): Promise<boolean> {
  const db = createDbForWorker(env as unknown as Bindings);
  const [row] = await db.select({ role: userTable.role }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  return row?.role === 'admin';
}

/**
 * Authorize, then hand the request to the canvas's room. The room-level guard (refuse a
 * non-empty room unless `?force=1`) lives in `handleSnapshotRequest`; this is only the gate.
 */
export async function handleCanvasSnapshot(
  request: Request,
  env: Env,
  canvasId: string,
  user: GateUser | null,
  /** Injected so the gate is testable without a database; production uses the default,
   *  matching how `handleCanvasMutate` injects `canReach`. */
  isAdmin: (env: Env, userId: string) => Promise<boolean> = isAdminUser,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // TWO principals (#329). The admin session is the human's; the operator token is the
  // migration script's, so `load --target <origin>` no longer needs a session cookie
  // pasted out of devtools. Neither implies `?force=1` — the room's non-empty guard
  // (worker/snapshot-io.ts) is untouched by who is calling.
  const principal = await authorize(request, env, canvasId, user, isAdmin);
  if (typeof principal !== 'string') return principal;

  // Overwriting a canvas is an operator action, so it is attributable: which principal,
  // which canvas, and whether they asked to replace a non-empty room.
  if (request.method === 'POST') {
    const force = new URL(request.url).searchParams.get('force') === '1';
    console.log(`[snapshot] replace canvas=${canvasId} principal=${principal} force=${force}`);
  }

  const id = env.CANVAS_SYNC.idFromName(syncRoomName(canvasId));
  // Identity is stamped after authorization and can never be client-supplied, matching
  // how `handleSyncUpgrade` and `handleCanvasMutate` establish it.
  const forwarded = new Request(request);
  forwarded.headers.set(SYNC_USER_HEADER, principal);
  return env.CANVAS_SYNC.get(id).fetch(forwarded);
}

/**
 * The identity to stamp on the hop to the room, or the Response that refuses the caller.
 *
 * An operator token is checked FIRST and only when one is presented, so the admin-session
 * path is byte-for-byte what it was: a browser sends no bearer here.
 */
async function authorize(
  request: Request,
  env: Env,
  canvasId: string,
  user: GateUser | null,
  isAdmin: (env: Env, userId: string) => Promise<boolean>,
): Promise<string | Response> {
  const presented = presentedBearer(request);
  if (presented) {
    // No secret configured means no operator principal exists — never a pass.
    const secret = env.BETTER_AUTH_SECRET;
    if (!secret) return json({ error: 'unauthorized' }, 401);
    const result = await verifyCanvasOperatorToken(secret, CANVAS_SNAPSHOT_LABEL, canvasId, presented);
    // The token is bound to THIS canvas and THIS label and expires on its own, so a leaked
    // one dies without rotating BETTER_AUTH_SECRET (which would log out every session).
    return result.ok ? OPERATOR_PRINCIPAL : json({ error: operatorRejection(result.reason) }, 401);
  }

  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!(await isAdmin(env, user.id))) return json({ error: 'forbidden' }, 403);
  return user.id;
}
