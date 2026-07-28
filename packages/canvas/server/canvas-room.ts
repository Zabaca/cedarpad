// The container half of the agent write path (ADR-0019, #305): how the bridge opens a
// `CanvasStore` on a canvas's Durable-Object-hosted room.
//
// One store per tool call — open → mutate → flush → discard (`src/remote-store.ts`). There
// is deliberately no long-lived mirror here: a cached store would go stale the moment a
// browser edited the room, and the room, not this process, is authoritative now.

import type { FetchAsset, ImageBytes } from '../src/canvas-ops.ts';
import { openRemoteCanvasStore, type RemoteCanvasStore } from '../src/remote-store.ts';
import { canvasAssetReadToken } from '../shared/canvas-asset-read.ts';
import { canvasMutatePath, canvasMutateToken } from '../shared/canvas-mutation.ts';

export interface CanvasRoomConfig {
  /** The edge origin (PLATFORM_RPC_ORIGIN, injected by worker/container-env.ts). */
  origin: string | undefined;
  /** The shared trust root the service bearer is derived from (BETTER_AUTH_SECRET). */
  secret: string | undefined;
  /** Test seam, as `platformRpcConfig`'s. */
  fetchImpl?: typeof fetch;
}

/**
 * `(canvasId) => a store on that canvas's room`.
 *
 * Unlike the platform RPC — which is best-effort, because a missed Inbox row must not fail a
 * turn — an unconfigured or unreachable edge here REJECTS. A canvas write that cannot reach
 * the room has not happened, and the one outcome worth ruling out is the agent reporting
 * success while the canvas stays empty (exactly the bug this slice closes).
 */
export function canvasRoomOpener(config: CanvasRoomConfig): (canvasId: string) => Promise<RemoteCanvasStore> {
  const origin = config.origin?.replace(/\/$/, '');
  const doFetch = config.fetchImpl ?? fetch;
  return async (canvasId: string) => {
    if (!origin || !config.secret) {
      throw new Error('canvas writes need the edge: no edge origin / auth secret is configured for this bridge');
    }
    return openRemoteCanvasStore(`${origin}${canvasMutatePath(canvasId)}`, doFetch, {
      authorization: `Bearer ${await canvasMutateToken(config.secret)}`,
    });
  };
}

/** The only `src` this will fetch: the asset route `src/canvas-sync.ts` mints, one flat
 *  key. The shape's `src` comes out of a room ANY member can write, so it is attacker-
 *  influenced input — without this the `read_image` tool would be a credentialed fetch at
 *  a URL of the writer's choosing. Relative-only, so the origin is ours by construction. */
const ASSET_SRC = /^\/api\/canvas-assets\/[^/]+\/[^/]+$/;

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** The asset door serves the raw object and does NOT stamp a content type (R2 is written
 *  with no httpMetadata), so the object KEY — which `src/canvas-sync.ts` builds from the
 *  uploaded file's name — is the only type information that survives. The header is still
 *  preferred when something upstream does supply one. */
function mimeTypeOf(res: Response, src: string): string {
  const header = res.headers.get('content-type');
  if (header?.startsWith('image/')) return header.split(';')[0]!.trim();
  const ext = src.slice(src.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? 'image/png';
}

/**
 * `(src) => the bytes behind it`, for `read_image` (#340).
 *
 * Since #290 an image shape's `src` is a URL on the edge's asset route, not an inline data
 * URL, and the container has no session — so the tool cannot just read the record, it has
 * to fetch, presenting the container's own read-only asset credential
 * (shared/canvas-asset-read.ts).
 *
 * NO SIZE LIMIT, deliberately visible rather than silent: neither the upload door
 * (worker/canvas-assets.ts) nor the browser's asset store caps an object, so an arbitrarily
 * large screenshot base64s straight into the agent's context. Capping here would fail the
 * tool on a legitimate large image, which is a product call, not one to make in a bug fix.
 */
export function canvasAssetFetcher(config: CanvasRoomConfig): FetchAsset {
  const origin = config.origin?.replace(/\/$/, '');
  const doFetch = config.fetchImpl ?? fetch;
  return async (src: string): Promise<ImageBytes> => {
    if (!origin || !config.secret) throw new Error('no edge origin / auth secret is configured for this bridge');
    if (!ASSET_SRC.test(src)) throw new Error(`"${src.slice(0, 48)}" is not a canvas asset URL`);
    const res = await doFetch(`${origin}${src}`, {
      headers: { authorization: `Bearer ${await canvasAssetReadToken(config.secret)}` },
    });
    if (!res.ok) throw new Error(`the edge answered ${res.status} for ${src}`);
    return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: mimeTypeOf(res, src) };
  };
}
