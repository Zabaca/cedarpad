// The authenticated HTTP mutation endpoint for a canvas's sync room (ADR-0019, #291) —
// the agent write path's door, sitting beside `/connect`'s WebSocket upgrade.
//
// It SELF-GATES ahead of `decideGate` for the same reason `/connect` does: the gate's
// deny branch answers with the login HTML at status 200, and an agent client needs a real
// status code. It also parses the zod contract HERE, before addressing a Durable Object,
// so a malformed payload costs no DO wake and can never reach the room.
//
// Note the constraint from #288: `CANVAS_SYNC` is an unparameterised
// `DurableObjectNamespace` (the class cannot `extends DurableObject`), so DO RPC is
// unavailable and `stub.fetch` is the only way in. This endpoint is that fetch.

import { CanvasMutation, mutationError } from '../shared/canvas-mutation.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { canReachCanvas, SYNC_USER_HEADER } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

const MUTATE_ROUTE = /^\/api\/canvas-sync\/([^/]+)\/mutate$/;

/** `/api/canvas-sync/:canvasId/mutate` → the canvas id, else null. */
export function parseCanvasMutatePath(pathname: string): string | null {
  return MUTATE_ROUTE.exec(pathname)?.[1] ?? null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Authorize, parse the contract, and hand the mutation to the canvas's room.
 *
 * The canvas comes from the PATH, so naming someone else's canvas is exactly what the
 * 403 refuses — there is no ambient "current canvas". The user id is stamped onto the
 * forwarded request after authorization and can never be client-supplied, matching how
 * `handleSyncUpgrade` establishes identity.
 */
export async function handleCanvasMutate(
  request: Request,
  env: Env,
  canvasId: string,
  user: GateUser | null,
  /** Injected so the gate is testable without a database; production uses the default. */
  canReach: (env: Env, canvasId: string, userId: string) => Promise<boolean> = canReachCanvas,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!(await canReach(env, canvasId, user.id))) return json({ error: 'forbidden' }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  const parsed = CanvasMutation.safeParse(body);
  if (!parsed.success) return json({ error: mutationError(parsed.error) }, 400);

  const id = env.CANVAS_SYNC.idFromName(syncRoomName(canvasId));
  // Forward the PARSED value, not the caller's bytes: the DO parses it again (both sides,
  // one schema — CLAUDE.md §7), and re-serializing means unknown keys never travel.
  const forwarded = new Request(request.url, {
    method: 'POST',
    body: JSON.stringify(parsed.data),
    headers: { 'content-type': 'application/json', [SYNC_USER_HEADER]: user.id },
  });
  return env.CANVAS_SYNC.get(id).fetch(forwarded);
}
