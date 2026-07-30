// The wire contract for the agent write path onto a canvas's tldraw sync room
// (ADR-0019, #291). ONE zod module, parsed on BOTH sides (CLAUDE.md §7): the caller
// (`createRemoteCanvasStore`, src/remote-store.ts) parses what it receives, and the
// Durable Object parses what it is given before a single record is built.
//
// What crosses this boundary is the SIMPLIFIED shape model (src/shapes.ts) — the same
// intent an agent tool already produces — never a `TLRecord`. The typed builder inside
// the DO (src/tl-record-builder.ts) is the only thing that constructs records, so a
// malformed agent payload is rejected here and never reaches the room.

import { z } from 'zod';

import { serviceToken, verifyServiceToken } from './service-token.ts';
import { DataSourceSchema } from './mart-contract.ts';

// --- the boundary: where the endpoint is, and who the container is when it calls -------

/** `POST` here to mutate a canvas's room. The canvas is in the PATH, never ambient. */
export const canvasMutatePath = (canvasId: string): string => `/api/canvas-sync/${encodeURIComponent(canvasId)}/mutate`;

/** HMAC label for the container's bearer. Distinct from `platform-rpc/v1` on purpose: a
 *  token minted for the chat-lifecycle RPC must not be replayable as a canvas write. */
const TOKEN_LABEL = 'canvas-mutate/v1';

/** The bearer the bridge presents — `HMAC-SHA256(BETTER_AUTH_SECRET, 'canvas-mutate/v1')`,
 *  the same trust root and the same shape as ADR-0018's platform RPC (#305). */
export const canvasMutateToken = (secret: string): Promise<string> => serviceToken(secret, TOKEN_LABEL);
export const verifyCanvasMutateToken = (secret: string, presented: string): Promise<boolean> =>
  verifyServiceToken(secret, TOKEN_LABEL, presented);

/**
 * The identity a container-authenticated mutation acts under, stamped by the edge and read
 * by the room. NOT a user id, and deliberately not one that could collide with a Better
 * Auth id: an agent write is the container acting on behalf of whoever's agent is running,
 * and the bridge has no session to name. The room records it as the writer's principal.
 */
export const CONTAINER_PRINCIPAL = 'service:container';
import type { CanvasShape, CanvasState } from '../src/shapes.ts';
import { SHAPE_COLORS } from '../src/shapes.ts';

const Color = z.enum(SHAPE_COLORS);
const Id = z.string().min(1);

/** Fields every shape carries. `parentId` present ⇒ x/y are frame-relative; `page`
 *  present ⇒ the shape is not on the canvas's first page. Both may be set at once (a
 *  frame on page two holding a shape). */
const base = { id: Id, color: Color, parentId: Id.optional(), page: Id.optional() };
const box = { ...base, x: z.number(), y: z.number(), w: z.number(), h: z.number() };
const point = { ...base, x: z.number(), y: z.number() };

const ComponentStatusSchema = z.union([
  z.object({ phase: z.literal('loading'), attempt: z.number() }),
  z.object({ phase: z.literal('ready') }),
  z.object({ phase: z.literal('load_error'), message: z.string(), attempts: z.number() }),
  z.object({ phase: z.literal('render_error'), message: z.string(), where: z.string() }),
]);

export const CanvasShapeSchema = z.discriminatedUnion('type', [
  z.object({ ...box, type: z.literal('rectangle'), text: z.string() }),
  z.object({ ...box, type: z.literal('ellipse'), text: z.string() }),
  z.object({ ...point, type: z.literal('text'), text: z.string() }),
  z.object({ ...point, type: z.literal('note'), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('arrow'),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    text: z.string(),
    startShapeId: Id.optional(),
    endShapeId: Id.optional(),
  }),
  z.object({ ...base, type: z.literal('draw'), points: z.array(z.tuple([z.number(), z.number()])) }),
  z.object({
    ...box,
    type: z.literal('component'),
    module: z.string().min(1),
    data: z.record(z.unknown()),
    rev: z.number(),
    status: ComponentStatusSchema.optional(),
    dataSource: DataSourceSchema.optional(),
  }),
  z.object({ ...box, type: z.literal('chat'), title: z.string(), chatId: Id.optional() }),
  z.object({ ...box, type: z.literal('image'), src: z.string(), alt: z.string() }),
  z.object({ ...box, type: z.literal('frame'), name: z.string() }),
  z.object({ ...box, type: z.literal('embed'), url: z.string() }),
]);

// The contract IS the model: if src/shapes.ts gains a variant or a field, this fails to
// compile until the schema follows. That is what keeps "one contract" true rather than
// aspirational — a hand-maintained mirror would drift silently.
type _SchemaMatchesModel = z.infer<typeof CanvasShapeSchema> extends CanvasShape ? true : never;
type _ModelMatchesSchema = CanvasShape extends z.infer<typeof CanvasShapeSchema> ? true : never;
const _bothWays: [_SchemaMatchesModel, _ModelMatchesSchema] = [true, true];
void _bothWays;

/** The four `CanvasStore` methods, as one wire union. `read` is `getState`. */
export const CanvasMutation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('read') }),
  z.object({ op: z.literal('upsert'), shapes: z.array(CanvasShapeSchema).min(1) }),
  z.object({ op: z.literal('remove'), ids: z.array(Id).min(1) }),
  z.object({ op: z.literal('clear') }),
]);
export type CanvasMutation = z.infer<typeof CanvasMutation>;

/** The canvas's pages, ordered as the page switcher shows them. Names are tldraw's, so
 *  they are neither unique nor id-like — resolving one to an id is `shared/canvas-pages.ts`,
 *  never this module: the room speaks ids only. */
export const CanvasPageSchema = z.object({ id: Id, name: z.string() });

/** Every op answers with the room's post-state, so the caller never needs a second
 *  round trip to refresh its mirror. `version` is the room's document clock. */
export const CanvasMutationResult = z.object({
  version: z.number(),
  shapes: z.array(CanvasShapeSchema),
  // Optional on the WIRE for the same reason it is optional on `CanvasState`, and for one
  // more: a room answered by an older worker has no `pages` key, and a read must not start
  // failing to parse mid-rollout.
  pages: z.array(CanvasPageSchema).optional(),
});
export type CanvasMutationResult = z.infer<typeof CanvasMutationResult>;

const _resultIsState: CanvasMutationResult extends CanvasState ? true : never = true;
void _resultIsState;

/** One human-readable line out of a failed `safeParse` — matches `wireError`'s shape so
 *  an agent sees the same style of message wherever the rejection happened. */
export function mutationError(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}
