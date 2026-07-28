// The OPERATOR credential on the migration doors (#329) — the second principal beside the
// admin session, so `scripts/migrate-canvas-rooms.ts load --target <origin>` can run from
// the environment instead of from a session cookie pasted out of devtools.
//
// Derived from BETTER_AUTH_SECRET via `shared/service-token.ts`, the same trust root the
// guest cookie and the platform RPC use — no new secret in sops, therefore no new deploy
// gate (#305's argument, and why that pattern was chosen).
//
// Request-bound, not static: each token is signed over `label | canvasId | timestamp` and
// accepted only inside `REQUEST_BOUND_WINDOW_MS`. See service-token.ts for why the static
// form was rejected here.
//
// ONE LABEL PER DOOR, as everywhere else in this codebase: a token minted for the snapshot
// door cannot be presented at the asset door, and neither can be replayed as
// `platform-rpc/v1` or `canvas-mutate/v1`.

import { type RequestBoundResult, requestBoundToken, verifyRequestBoundToken } from './service-token.ts';

/** `GET`/`POST /api/canvas-sync/:canvasId/snapshot` — read or REPLACE a canvas's document. */
export const CANVAS_SNAPSHOT_LABEL = 'canvas-snapshot/v1';

/** `PUT /api/canvas-assets/:canvasId/:key` — the image bytes a snapshot's shapes point at.
 *  Its own door, so its own label: `load` puts the bytes before the document that names
 *  them, and the operator running a migration is not necessarily a member of the workspace
 *  that owns the canvas (which is why `canReachCanvas` alone cannot serve this run). */
export const CANVAS_ASSET_LABEL = 'canvas-asset/v1';

/** The principal name the doors log and stamp on the hop to the Durable Object. */
export const OPERATOR_PRINCIPAL = 'service:operator';

export const canvasOperatorToken = (secret: string, label: string, canvasId: string, now?: number): Promise<string> =>
  requestBoundToken(secret, label, canvasId, now);

export const verifyCanvasOperatorToken = (
  secret: string,
  label: string,
  canvasId: string,
  presented: string,
): Promise<RequestBoundResult> => verifyRequestBoundToken(secret, label, canvasId, presented);

/** Both ends agree on ONE header, so a caller never has to know which door it is at. */
export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

export const presentedBearer = (request: Request): string | null =>
  request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;

/** What a refused operator token answers. `skew` is called out by name so the next
 *  operator does not debug a clock difference as an authentication failure. */
export function operatorRejection(reason: Exclude<RequestBoundResult, { ok: true }>['reason']): string {
  return reason === 'skew'
    ? 'operator token timestamp is outside the accepted window — this is CLOCK SKEW between the caller and the edge, not a bad credential. Check the clock on the machine that minted it.'
    : 'invalid operator token';
}
