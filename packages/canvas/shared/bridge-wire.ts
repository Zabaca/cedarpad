import { z } from 'zod';

// The edge↔bridge wire: the ONE module that owns the typed contract spoken across the
// Cloudflare-worker ↔ container-bridge seam (CLAUDE.md §7), the same convention as
// shared/chat-wire.ts and shared/skills-wire.ts. Both sides import from here, so a
// header rename, a name rule, or a route path changes in exactly one place:
//   - EDGE (stamps headers, proxies bodies): worker/index.ts, worker/mcp-server.ts,
//     worker/mcp-tools.ts, worker/huddle.ts,
//     and worker/guest-gate.ts (whose allowlist derives from BRIDGE_ROUTES below).
//   - BRIDGE (reads headers, parses bodies): server/bridge.ts (+ server/components.ts,
//     which enforces the same name rules on the filesystem).
//   - PAD (browser side of the same header contract): src/active-canvas.ts, shared/chat-store.ts.
//
// A typo used to fail silently on either side (`?? undefined`); a renamed bridge route
// used to silently drop guests. Constants close both holes.
//
// One neighbouring header contract deliberately stays where its consumers already import
// it: MCP_TOKENS_HEADER (server/mcp-registry.ts).

// --- header names ---------------------------------------------------------------

/** Which canvas a request addresses; absent → `?canvas=` → the default canvas. */
export const CANVAS_ID_HEADER = 'x-canvas-id';
/** Stamped by the edge on a guest-session proxy: confines the chat SSE fan-out to this canvas. */
export const GUEST_CANVAS_HEADER = 'x-guest-canvas';
/** The guest's capabilities (#320), JSON per `shared/guest-capabilities.ts`, stamped by the
 *  edge next to `x-guest-canvas` and parsed by the bridge with `readGuestCapabilities`.
 *  Present ⟺ the request is a guest's; the edge always writes it, so a client cannot. */
export const GUEST_CAPS_HEADER = 'x-guest-caps';
/**
 * WHO is asking, for PRESENTATION-ONLY targeting — whose open editor a `select_page` moves.
 *
 * NEVER an authorization input. The bridge is deliberately identity-blind: an agent write is
 * the container acting on behalf of whoever's agent is running, and it authorizes as
 * `CONTAINER_PRINCIPAL` (shared/canvas-mutation.ts) no matter who this names. Reaching for
 * this header to decide whether something is ALLOWED would give a presentation hint the
 * weight of a credential — the edge is the only gate, and it has already run.
 *
 * Stamped by the edge from the resolved session and overwritten on every proxy, so a client
 * cannot claim to be someone else. ABSENT means "no identifiable viewer": a guest (whose
 * per-browser identity lives in localStorage and never reaches the edge, src/identity.ts),
 * or an unattributed headless run. Absent is NOT a wildcard — a fan-out with no
 * viewer targets nobody, so the failure mode is "nothing moved", never "everyone moved".
 */
export const CANVAS_VIEWER_HEADER = 'x-canvas-viewer';
/** A send with no subscriber by design (the e2e suite), bypassing the subscribe-before-send guard. */
export const HEADLESS_SEND_HEADER = 'x-headless-send';
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

// --- size rules -----------------------------------------------------------------

/** D1's documented maximum for one string value — and for one table row (ADR-0022 decision 3:
 *  "max row/string 2 MB"). This is the ceiling a data file Record actually has to fit under,
 *  and the only thing the cap below is derived from. */
export const D1_MAX_VALUE_BYTES = 2_000_000;

/**
 * The largest data file `write_data` will author, in UTF-8 bytes.
 *
 * HALF the store's ceiling, deliberately. The source is the only large column, but the row
 * also carries its key, and every write appends a second row holding an identical copy — so
 * the value has to fit twice over, with the key columns, inside a limit that is stated per
 * row as well as per value. Half leaves that headroom without arithmetic that would drift
 * the next time a column is added.
 *
 * NOT inherited from the old 1 MiB cap, whose stated reason was "the components sink tars the
 * whole dir on every flush" — that sink is gone (ADR-0022), and with it that justification.
 */
export const DATA_MAX_BYTES = D1_MAX_VALUE_BYTES / 2;

/** Bytes, not characters — the unit the store is limited in. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A data file's content on the wire. The cap is part of the CONTRACT, so an oversized upload
 *  is a 400 at whichever boundary sees it first rather than a store exception surfaced raw. */
export const DataFileSource = z
  .string()
  .min(1, 'source must be non-empty')
  .refine((s) => utf8Bytes(s) <= DATA_MAX_BYTES, `data file too large (max ${DATA_MAX_BYTES} bytes)`);

/**
 * The same two rules as throwing assertions, for the paths that are not a zod parse: the
 * agent tool inside the container (which wants the message, not a 400) and the edge's
 * data-file policy (which must not trust the container's payload). ONE definition, enforced
 * in both places — the closed extension set is the whole reason `write_data` is a separate
 * tool from `write_component`, and it only holds if every door checks it.
 */
export function assertDataFileName(name: string): void {
  if (!DATA_FILE_NAME_RE.test(name)) {
    throw new Error(`invalid data file name "${name}" — <letters/digits/_/->.(json|csv|txt|md); use write_component for code`);
  }
}

/** Content rules that depend on the name: the size cap, and `.json` that must PARSE — one
 *  unparseable data file breaks the build of every Component that imports it. */
export function assertDataFileSource(name: string, source: string): void {
  if (typeof source !== 'string' || source.length === 0) throw new Error('source must be non-empty');
  if (utf8Bytes(source) > DATA_MAX_BYTES) {
    throw new Error(`data file too large (max ${DATA_MAX_BYTES} bytes; the store holds ${D1_MAX_VALUE_BYTES} per row)`);
  }
  if (name.endsWith('.json')) {
    try {
      JSON.parse(source);
    } catch {
      throw new Error('source is not valid JSON — a broken .json import breaks every component that imports it');
    }
  }
}

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
  /** Which page to land on. Absent means the canvas's first page (src/shapes.ts), so every
   *  existing caller is unchanged. Without this the palette could only ever place onto page
   *  one, whatever page the human was looking at. */
  page: z.string().min(1).optional(),
});
/** Run one of a placed component's declared `commands` against its live data. `args` stays a
 *  loose record here: the command's own zod schema, exported by the component, validates it. */
export const CallComponentBody = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.record(z.unknown()).default({}),
});
export const WriteComponentBody = z.object({ source: z.string().min(1) });
/**
 * A CONTENT-anchored edit: `old_string` becomes `new_string`. The anchor must occur exactly
 * once unless `replace_all` — and that match is the point of the shape. It is the caller's
 * proof that it is editing the text it believes is there, which is precisely what addressing
 * by line number cannot do once an earlier edit has shifted the numbers underneath it.
 *
 * `new_string` may be empty (delete the anchor); `old_string` may not (an empty anchor
 * matches everywhere and means nothing).
 */
export const EditComponentBody = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
export type EditComponentBody = z.infer<typeof EditComponentBody>;
export const WriteDataBody = z.object({ source: DataFileSource });

/** One human-readable line out of a failed `safeParse`, for the bridge's `{ error }` 400s. */
export function wireError(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

// --- routes ---------------------------------------------------------------------

/** The canvas-API paths that appear in the guest allowlist (worker/guest-gate.ts) and/or
 * the MCP proxy (worker/mcp-tools.ts) — NOT every bridge route. The bridge's own route
 * matches read from here too, so the guest allowlist can no longer drift from the paths
 * the bridge actually serves. */
// (#297 removed two entries with the old sync plane: `canvasStream` — `/api/canvas/stream`
// still exists but carries only the agent's screenshot ask, is not guest-reachable and is not
// an MCP route, so it has no business here — and `shapes`, the browser's whole-shape upsert,
// whose route is gone entirely.)
export const BRIDGE_ROUTES = {
  canvas: '/api/canvas',
  shapesCreate: '/api/canvas/shapes/create',
  shapesUpdate: '/api/canvas/shapes/update',
  deleteShapes: '/api/canvas/delete',
  components: '/api/components',
  componentsPlace: '/api/components/place',
  componentsCall: '/api/components/call',
  selectPage: '/api/canvas/select-page',
  canvasImage: '/api/canvas/image',
  canvasView: '/api/canvas/view',
} as const;

/** Move a viewer's OPEN EDITOR to a page. Not a canvas mutation: nothing about the
 *  document changes, only which page one person is looking at — which is why it is a
 *  route of its own rather than an op on the mutation contract. `pageId` is already
 *  resolved (`shared/canvas-pages.ts` did that at the tool layer); the bridge never
 *  sees a page NAME. */
export const SelectPageBody = z.object({ pageId: z.string().min(1) });
export type SelectPageBody = z.infer<typeof SelectPageBody>;

/** One image shape's pixels (`GET /api/canvas/image?id=`): base64, no `data:` prefix — what
 *  an MCP `image` content block carries. */
export const CanvasImageResult = z.object({ data: z.string(), mimeType: z.string() });
export type CanvasImageResult = z.infer<typeof CanvasImageResult>;

/** What a canvas screenshot renders: `ids` (those shapes — a frame brings its contents),
 *  else page `pageId` (already resolved, as for `SelectPageBody`), else whatever page the
 *  answering tab is on. The same object is the `POST /api/canvas/view` body and rides the
 *  `screenshot` SSE frame to the browser. */
export const ScreenshotTarget = z.object({
  pageId: z.string().min(1).optional(),
  ids: z.array(z.string().min(1)).min(1).optional(),
});
export type ScreenshotTarget = z.infer<typeof ScreenshotTarget>;
/** A null `url` from the view route is "nobody answered", not an error. */
export const ViewCanvasBody = ScreenshotTarget;
export type ViewCanvasBody = ScreenshotTarget;
export const ViewCanvasResult = z.object({ url: z.string().nullable() });
export type ViewCanvasResult = z.infer<typeof ViewCanvasResult>;
