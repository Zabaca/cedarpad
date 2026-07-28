import {
  CANVAS_ASSET_LABEL,
  operatorRejection,
  presentedBearer,
  verifyCanvasOperatorToken,
} from '../shared/canvas-operator-token.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { canReachCanvas } from './sync-api.ts';

// Where canvas image/video bytes live (ADR-0019). The tldraw document carries a URL on
// this route; R2 carries the pixels. The old plane inlined a base64 data URL into the
// shape record, which the sync room would now persist in DO SQLite and rebroadcast — the
// exact per-edit cost the migration exists to remove.
//
// It SELF-GATES, like the sync upgrade next door: the session gate's deny branch answers
// with the login HTML at status 200, which an `<img src>` renders as a broken box rather
// than a signal. A refused asset must be a status code.

/** `/api/canvas-assets/:canvasId/:key` → its parts, else null. `key` is ONE segment —
 *  the client mints flat keys (`src/canvas-sync.ts`), so a nested path is not ours. */
const ASSET_ROUTE = /^\/api\/canvas-assets\/([^/]+)\/([^/]+)$/;

export interface CanvasAssetRef {
  canvasId: string;
  key: string;
}

export function parseAssetPath(pathname: string): CanvasAssetRef | null {
  const m = ASSET_ROUTE.exec(pathname);
  return m ? { canvasId: decodeURIComponent(m[1]!), key: decodeURIComponent(m[2]!) } : null;
}

/** The write half of the bucket, which `MartBucket` deliberately does not carry
 *  (mart-api's backend is read-only on purpose). Narrow, structural, R2-compatible. */
export interface AssetBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, body: ArrayBuffer): Promise<unknown>;
}

/** Objects are keyed by canvas, so one canvas's assets can never be addressed
 *  through another canvas's id even if the object key leaks. */
function objectPath(ref: CanvasAssetRef): string {
  return `canvas-assets/${ref.canvasId}/${ref.key}`;
}

/**
 * Read or write one canvas asset.
 *
 * The canvas comes from the PATH, so naming someone else's canvas is exactly what the
 * gate refuses — there is no ambient "current canvas" to fall back on. Both rejections
 * happen before the bucket is touched.
 *
 * Reachability is the SAME `canReachCanvas` the `/connect` upgrade and the `/mutate`
 * write path use (worker/sync-api.ts) — three doors onto one canvas, one answer to "may
 * this user reach it". A second implementation here would be a second thing to get wrong.
 */
export async function handleCanvasAsset(
  request: Request,
  env: Env,
  ref: CanvasAssetRef,
  user: GateUser | null,
  /** Injected so the gate is testable without a database; production uses the default. */
  canReach: (env: Env, canvasId: string, userId: string) => Promise<boolean> = canReachCanvas,
): Promise<Response> {
  // The operator principal (#329), checked only when a bearer is presented — a browser
  // sends none, so the member path below is unchanged. It exists because the migration
  // uploads a canvas's bytes before the snapshot that names them, and the operator running
  // it need not be a member of the workspace that owns that canvas: `canReachCanvas` is
  // the wrong question for that caller, exactly as it is on the snapshot door next door.
  // Its own label, bound to THIS canvas, and short-lived.
  const presented = presentedBearer(request);
  if (presented) {
    const secret = env.BETTER_AUTH_SECRET;
    if (!secret) return new Response('unauthorized', { status: 401 });
    const result = await verifyCanvasOperatorToken(secret, CANVAS_ASSET_LABEL, ref.canvasId, presented);
    if (!result.ok) return new Response(operatorRejection(result.reason), { status: 401 });
  } else {
    if (!user) return new Response('unauthorized', { status: 401 });
    if (!(await canReach(env, ref.canvasId, user.id))) return new Response('forbidden', { status: 403 });
  }

  const bucket = env.MART_BUCKET as unknown as AssetBucket;
  const path = objectPath(ref);

  if (request.method === 'PUT') {
    await bucket.put(path, await request.arrayBuffer());
    return new Response(null, { status: 200 });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const obj = await bucket.get(path);
    if (!obj) return new Response('not found', { status: 404 });
    return new Response(await obj.arrayBuffer(), {
      // Assets are immutable — the key carries a uuid, so a given key's bytes never
      // change and a client may cache it forever.
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }
  return new Response('method not allowed', { status: 405 });
}
