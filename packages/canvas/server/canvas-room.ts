// The container half of the agent write path (ADR-0019, #305): how the bridge opens a
// `CanvasStore` on a canvas's Durable-Object-hosted room.
//
// One store per tool call — open → mutate → flush → discard (`src/remote-store.ts`). There
// is deliberately no long-lived mirror here: a cached store would go stale the moment a
// browser edited the room, and the room, not this process, is authoritative now.

import { openRemoteCanvasStore, type RemoteCanvasStore } from '../src/remote-store.ts';
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
