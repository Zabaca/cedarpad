import { z } from 'zod';

import { DataSourceSchema } from './mart-contract';

// The edge↔bridge wire: the ONE module that owns the typed contract spoken across the
// Cloudflare-worker ↔ container-bridge seam (CLAUDE.md §7), the same convention as
// shared/chat-wire.ts and shared/skills-wire.ts. Both sides import from here, so a
// header rename, a name rule, or a route path changes in exactly one place:
//   - EDGE (stamps headers, proxies bodies): worker/index.ts, worker/mcp-server.ts,
//     worker/mcp-tools.ts, worker/inbox-bridge.ts, worker/dev-agent.ts, worker/huddle.ts,
//     and worker/guest-gate.ts (whose allowlist derives from BRIDGE_ROUTES below).
//   - BRIDGE (reads headers, parses bodies): server/bridge.ts (+ server/components.ts,
//     which enforces the same name rules on the filesystem).
//   - PAD (browser side of the same header contract): src/active-canvas.ts, shared/chat-store.ts.
//
// A typo used to fail silently on either side (`?? undefined`); a renamed bridge route
// used to silently drop guests. Constants close both holes.
//
// Two neighbouring header contracts deliberately stay where their consumers already
// import them: INBOX_ASSIGN_HEADER (shared/chat-wire.ts) and MCP_TOKENS_HEADER
// (server/mcp-registry.ts).

// --- header names ---------------------------------------------------------------

/** Which canvas a request addresses; absent → `?canvas=` → the default canvas. */
export const CANVAS_ID_HEADER = 'x-canvas-id';
/** Stamped by the edge on a guest-session proxy: confines the chat SSE fan-out to this canvas. */
export const GUEST_CANVAS_HEADER = 'x-guest-canvas';
/** A send with no subscriber by design (MCP / inbox), bypassing the subscribe-before-send guard. */
export const HEADLESS_SEND_HEADER = 'x-headless-send';
/** Edge-minted GitHub installation token for a dev-agent turn — per-request custody, never persisted. */
export const DEV_AGENT_GIT_TOKEN_HEADER = 'x-dev-agent-git-token';
/** The run's target repo (`owner/name`), resolved and stamped by the edge next to the token. */
export const DEV_AGENT_REPO_HEADER = 'x-dev-agent-repo';
/** Huddles (ADR-0017): the canvas whose voice room the agent worker should join. */
export const HUDDLE_CANVAS_HEADER = 'x-huddle-canvas';
/** The agent's edge-minted LiveKit room token (signing keys never enter the container). */
export const HUDDLE_AGENT_TOKEN_HEADER = 'x-huddle-agent-token';
export const LIVEKIT_URL_HEADER = 'x-livekit-url';
/** Inference credentials — the documented custody deviation, see worker/huddle.ts. */
export const LIVEKIT_API_KEY_HEADER = 'x-livekit-api-key';
export const LIVEKIT_API_SECRET_HEADER = 'x-livekit-api-secret';

// --- name rules -----------------------------------------------------------------

/** A component module: letters/digits/_/-, no extension. Enforced at the edge (MCP tool
 * input), at the bridge (place/write bodies) and on the filesystem (server/components.ts). */
export const COMPONENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A data file a component imports as a sibling — non-executable extensions only. */
export const DATA_FILE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*\.(json|csv|txt|md)$/;

export const ComponentName = z.string().regex(COMPONENT_NAME_RE, 'component name: letters/digits/_/-, no extension');
export const DataFileName = z
  .string()
  .regex(DATA_FILE_NAME_RE, 'data file name: letters/digits/_/- with a .json/.csv/.txt/.md extension');

// --- request bodies -------------------------------------------------------------

/** Shapes ride as LOOSE records on purpose: server-side `normalizeShape` is the single
 * shape validator (permissive schema, strict normalize), and its errors come back
 * agent-legible. Do not tighten these fields here. */
const ShapeRecord = z.record(z.unknown());

export const CreateShapesBody = z.object({ shapes: z.array(ShapeRecord).min(1) });
export const UpdateShapesBody = z.object({ shapes: z.array(ShapeRecord.and(z.object({ id: z.string().min(1) }))).min(1) });
export const DeleteShapesBody = z.object({ ids: z.array(z.string().min(1)).min(1) });
export const PlaceComponentBody = z.object({
  id: z.string().min(1).optional(),
  module: ComponentName,
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  data: z.record(z.unknown()).optional(),
  /** #239 / ADR-0017: a component names a mart, never a URL — this IS the boundary. */
  dataSource: DataSourceSchema.optional(),
});
export const WriteComponentBody = z.object({ source: z.string().min(1) });
export const WriteDataBody = z.object({ source: z.string().min(1) });

/** One human-readable line out of a failed `safeParse`, for the bridge's `{ error }` 400s. */
export function wireError(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

// --- routes ---------------------------------------------------------------------

/** The canvas-API paths that appear in the guest allowlist (worker/guest-gate.ts) and/or
 * the MCP proxy (worker/mcp-tools.ts) — NOT every bridge route. The bridge's own route
 * matches read from here too, so the guest allowlist can no longer drift from the paths
 * the bridge actually serves. */
export const BRIDGE_ROUTES = {
  canvas: '/api/canvas',
  canvasStream: '/api/canvas/stream',
  presence: '/api/canvas/presence',
  shapes: '/api/canvas/shapes',
  shapesCreate: '/api/canvas/shapes/create',
  shapesUpdate: '/api/canvas/shapes/update',
  deleteShapes: '/api/canvas/delete',
  components: '/api/components',
  componentsPlace: '/api/components/place',
} as const;
