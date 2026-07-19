import { AccessToken } from 'livekit-server-sdk';
import type { Database } from '../web-poc/lib/db/client.ts';
import { get as getCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';
import type { GuestSession } from './guest-session.ts';
import { DEFAULT_CANVAS_ID, DEFAULT_WORKSPACE_ID } from './shell-routing.ts';
import { canvasHiddenFrom } from './visibility.ts';

// Huddles (ADR-0017): a voice room per canvas. The edge holds the LiveKit signing keys
// and mints short-lived room tokens; the room IS the canvas id. Access is checked through
// the canvas's workspace exactly like share links (a canvas you can't see is a 404).

export type LiveKitEnv = {
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
};

const TOKEN_TTL = '2h';

async function mintRoomToken(env: LiveKitEnv, room: string, identity: string): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity, ttl: TOKEN_TTL });
  at.addGrant({ room, roomJoin: true });
  return at.toJwt();
}

/** The canvas's workspace if the caller is owner-or-member; null ⇒ 404 (same as share links). */
async function accessibleCanvasWorkspace(db: Database, canvasId: string, user: GateUser): Promise<string | null> {
  const row = canvasId === DEFAULT_CANVAS_ID ? null : await getCanvas(db, canvasId);
  if (row && canvasHiddenFrom(row, user.id)) return null;
  const workspaceId = canvasId === DEFAULT_CANVAS_ID ? DEFAULT_WORKSPACE_ID : row?.workspaceId;
  if (!workspaceId) return null;
  const ws = await getWorkspace(db, workspaceId, user.id);
  return ws ? workspaceId : null;
}

/** POST /api/canvases/:canvasId/huddle/join → 200 {url, token, room} */
export async function handleHuddleJoin(
  request: Request,
  db: Database,
  user: GateUser,
  canvasId: string,
  env: LiveKitEnv,
): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
  const workspaceId = await accessibleCanvasWorkspace(db, canvasId, user);
  if (!workspaceId) return Response.json({ error: 'canvas not found' }, { status: 404 });
  const token = await mintRoomToken(env, canvasId, user.id);
  return Response.json({ url: env.LIVEKIT_URL, token, room: canvasId });
}

/** Guest variant: allowed only for the link's own canvas on a guestHuddle link (404 otherwise,
 * same non-confirming shape as the member path). Identity is derived from the link. */
export async function handleGuestHuddleJoin(
  request: Request,
  guest: GuestSession,
  canvasId: string,
  env: LiveKitEnv,
): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
  if (!guest.guestHuddle || guest.canvasId !== canvasId) {
    return Response.json({ error: 'canvas not found' }, { status: 404 });
  }
  const token = await mintRoomToken(env, canvasId, `guest:${guest.linkId}`);
  return Response.json({ url: env.LIVEKIT_URL, token, room: canvasId });
}

export const HUDDLE_ENSURE_PATH = '/api/huddle/ensure';
export const HUDDLE_AGENT_IDENTITY = 'cedar';

/** Poke the canvas's bridge to ensure the agent worker (ADR-0017 explicit spawn). The
 * agent's room token is minted HERE and rides a header — signing keys stay edge-side.
 * Best-effort: a failed poke logs; the humans' huddle still works, just agent-less. */
export async function ensureHuddleWorker(
  env: LiveKitEnv,
  canvasId: string,
  serve: (req: Request) => Promise<Response>,
): Promise<void> {
  try {
    const agentToken = await mintRoomToken(env, canvasId, HUDDLE_AGENT_IDENTITY);
    const req = new Request(`https://bridge.internal${HUDDLE_ENSURE_PATH}`, {
      method: 'POST',
      headers: {
        'x-huddle-canvas': canvasId,
        'x-huddle-agent-token': agentToken,
        'x-livekit-url': env.LIVEKIT_URL,
        // Deliberate ADR-0017 custody deviation: LiveKit Inference (STT/TTS) mints its
        // own short-lived gateway tokens from key+secret INSIDE the worker process — no
        // pre-minted-token seam exists. Scope: per-spawn process env, never persisted
        // container config; blast radius is the LiveKit project, not the RCE boundary.
        'x-livekit-api-key': env.LIVEKIT_API_KEY,
        'x-livekit-api-secret': env.LIVEKIT_API_SECRET,
      },
    });
    const res = await serve(req);
    if (!res.ok) console.error(`[huddle] worker ensure failed: ${res.status} ${await res.text().catch(() => '')}`);
  } catch (e) {
    console.error(`[huddle] worker ensure errored: ${String(e)}`);
  }
}
