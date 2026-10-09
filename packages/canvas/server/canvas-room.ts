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
 * An unconfigured or unreachable edge here REJECTS. A canvas write that cannot reach
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
 *  key. The shape's `src` comes out of a room ANY member — and, since #333, any
 *  `guest_edit` share-link guest — can write, so it is attacker-CHOSEN input, and the
 *  credential it is fetched with is the container's. Relative-only, so the origin is ours
 *  by construction; the canvas segment is then checked against the open canvas below. */
const ASSET_SRC = /^\/api\/canvas-assets\/([^/]+)\/([^/]+)$/;

/** As the door decodes (`parseAssetPath`). A malformed escape is not a segment we minted,
 *  so it fails the comparisons above rather than throwing out of the tool. */
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

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
 * `(canvasId) => (src) => the bytes behind it`, for `read_image` (#340).
 *
 * Since #290 an image shape's `src` is a URL on the edge's asset route, not an inline data
 * URL, and the container has no session — so the tool cannot just read the record, it has
 * to fetch, presenting the container's own read-only asset credential
 * (shared/canvas-asset-read.ts).
 *
 * BOUND TO ONE CANVAS, like `canvasRoomOpener` next door, and for a sharper reason than
 * symmetry: `canvas-asset-read/v1` is a static token the edge accepts for ANY canvas, and
 * the `src` it is pointed at comes out of a room a `guest_edit` share-link guest can write
 * (#333). Unbound, that is a confused deputy — the guest chooses the target, the container
 * supplies the authority, and another canvas's screenshot lands in a conversation the guest
 * can read. So the path's canvas segment must be the canvas the store is open on, compared
 * AFTER decoding (the door decodes too, so `%63anvas_y` must not slip past an equality
 * check that `canvas_y` would fail).
 *
 * NO SIZE LIMIT, deliberately visible rather than silent: neither the upload door
 * (worker/canvas-assets.ts) nor the browser's asset store caps an object, so an arbitrarily
 * large screenshot base64s straight into the agent's context. Capping here would fail the
 * tool on a legitimate large image, which is a product call, not one to make in a bug fix.
 */
export function canvasAssetFetcher(config: CanvasRoomConfig): (canvasId: string) => FetchAsset {
  const origin = config.origin?.replace(/\/$/, '');
  const doFetch = config.fetchImpl ?? fetch;
  return (canvasId: string) => async (src: string): Promise<ImageBytes> => {
    if (!origin || !config.secret) throw new Error('no edge origin / auth secret is configured for this bridge');
    const parts = ASSET_SRC.exec(src);
    if (!parts) throw new Error(`"${src.slice(0, 48)}" is not a canvas asset URL`);
    const [, rawCanvas, rawKey] = parts as unknown as [string, string, string];
    if (decode(rawCanvas) !== canvasId) {
      throw new Error(`"${src.slice(0, 48)}" belongs to another canvas — this chat is on ${canvasId}`);
    }
    // The regex forbids a literal `/`, but the door percent-DECODES the key before keying
    // R2 (worker/canvas-assets.ts), so `%2F` would put a separator back into the object
    // path. Nothing can be addressed outside the `canvas-assets/<canvas>/` prefix that way
    // — R2 keys are opaque strings, so a `..` is a literal `..`, not a parent — but the
    // client only ever mints `[A-Za-z0-9._-]` keys (`objectKey`, src/canvas-sync.ts), so a
    // decoded separator is not a shape we authored and there is no reason to fetch it.
    if (decode(rawKey).includes('/')) throw new Error(`"${src.slice(0, 48)}" is not a flat asset key`);
    const res = await doFetch(`${origin}${src}`, {
      headers: { authorization: `Bearer ${await canvasAssetReadToken(config.secret)}` },
    });
    if (!res.ok) throw new Error(`the edge answered ${res.status} for ${src}`);
    return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: mimeTypeOf(res, src) };
  };
}
