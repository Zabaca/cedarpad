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

import { CanvasMutation, CONTAINER_PRINCIPAL, mutationError, verifyCanvasMutateToken } from '../shared/canvas-mutation.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { workspaceKey } from '../shared/workspace-key.ts';
import { canReachCanvas, SYNC_USER_HEADER, workspaceOfCanvasForEnv } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

const MUTATE_ROUTE = /^\/api\/canvas-sync\/([^/]+)\/mutate$/;

/** `/api/canvas-sync/:canvasId/mutate` → the canvas id, else null. */
export function parseCanvasMutatePath(pathname: string): string | null {
  return MUTATE_ROUTE.exec(pathname)?.[1] ?? null;
}

/**
 * Is this the container of the canvas's workspace presenting its service bearer? (#374)
 *
 * The bearer is `HMAC(workspaceKey(secret, W), 'canvas-mutate/v1')`, so it verifies for one
 * workspace only. The canvas comes from the path, the edge asks the registry which workspace
 * owns it, derives THAT workspace's key and checks the bearer against it: a container for
 * another workspace, or a canvas the registry does not know, is not admitted. Unconfigured
 * secret or no bearer ⇒ never.
 */
async function isContainer(
  request: Request,
  env: Env,
  canvasId: string,
  workspaceOf: (env: Env, canvasId: string) => Promise<string | null>,
): Promise<boolean> {
  const secret = env.BETTER_AUTH_SECRET;
  const presented = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!secret || !presented) return false;
  const owner = await workspaceOf(env, canvasId);
  return owner !== null && (await verifyCanvasMutateToken(await workspaceKey(secret, owner), presented));
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
  /** Injected for the same reason: which workspace owns the canvas. */
  workspaceOf: (env: Env, canvasId: string) => Promise<string | null> = workspaceOfCanvasForEnv,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // TWO principals may write here, and only two.
  //
  // A BROWSER arrives with a Better Auth session and is checked per-canvas: the canvas
  // comes from the path, so naming someone else's canvas is exactly what the 403 refuses.
  //
  // The CONTAINER (#305) arrives with no session at all — the bridge is a server, and the
  // agent write it is carrying originates from a turn, not from a request the bridge can
  // attribute. Forwarding "the originating user" was considered and rejected: the bridge is
  // never told who that is (the edge stamps only `x-canvas-id` on its proxied calls, and the
  // in-canvas agent's tools have no requester at all), so it could only have been a claim the
  // bridge asserts — a service credential wearing a user's name, with the edge trusting the
  // container either way. We take the honest version: a SERVICE CREDENTIAL, minted as
  // ADR-0018's platform RPC mints its own (own label, derived from the container's
  // per-workspace key, no new secret in sops), admitted as `CONTAINER_PRINCIPAL`, and NOT run
  // through `canReach` (there is no user for that question to be about). Blast radius, stated
  // plainly: a caller holding this bearer may write to any canvas OF ITS OWN WORKSPACE (#374:
  // the key is the workspace's, and the edge checks it against the canvas's owner). That is
  // the trust the container already has: it serves the workspace's canvases and holds their
  // bytes. It cannot reach another workspace's canvases, and the key reveals nothing of
  // BETTER_AUTH_SECRET.
  const container = await isContainer(request, env, canvasId, workspaceOf);
  if (!container) {
    if (!user) return json({ error: 'unauthorized' }, 401);
    if (!(await canReach(env, canvasId, user.id))) return json({ error: 'forbidden' }, 403);
  }
  const principal = container ? CONTAINER_PRINCIPAL : user!.id;

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
    headers: { 'content-type': 'application/json', [SYNC_USER_HEADER]: principal },
  });
  return env.CANVAS_SYNC.get(id).fetch(forwarded);
}
