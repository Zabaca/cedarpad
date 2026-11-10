// The chat agent's canvas store FOR ONE TURN (ADR-0019, #310).
//
// The bridge's HTTP handlers open a room store per call — open → mutate → flush → discard
// (`server/canvas-room.ts`). A chat turn cannot do that: `runChat` is handed ONE
// `CanvasStore` for the whole turn and every tool in `src/canvas-ops.ts` consumes it
// synchronously, which is the seam ADR-0019 exists to protect.
//
// The resolution is that the await point already exists ONE LEVEL ABOVE canvas-ops.ts: every
// MCP tool handler in `server/agent.ts` is already `async`. So this wrapper is a
// synchronous `CanvasStore` (canvas-ops sees no change at all) with two async settle points
// the tool wrapper calls between tool calls:
//
//   - `commit()` after a tool that succeeded — flush, then reopen.
//   - `discard()` after a tool that refused — drop the queue, then reopen.
//
// Reopening after each settle is what makes this equivalent to the per-call pattern the HTTP
// handlers use: the next tool call sees a mirror freshly read from the room, so a human edit
// mid-turn is visible to the agent's next `read_canvas`, and a poisoned store never spans two
// tool calls.

import type { RemoteCanvasStore } from '../src/remote-store.ts';
import type { CanvasShape, CanvasState } from '../src/shapes.ts';
import type { CanvasStore } from '../src/store.ts';

export interface TurnCanvasStore extends CanvasStore {
  /** Send everything the last tool call queued, then reopen on the room's post-state.
   *  REJECTS with the room's own reason — the caller must surface it to the agent. */
  commit(): Promise<void>;
  /** Throw away what the last tool call queued (it refused) and reopen. Never rejects. */
  discard(): Promise<void>;
}

export async function openTurnCanvasStore(open: () => Promise<RemoteCanvasStore>): Promise<TurnCanvasStore> {
  let current = await open();

  // Reopen so the NEXT tool call reads the room rather than a mirror we already spent.
  // A reopen failure is deliberately NOT propagated: whatever the settle did (flush or
  // drop) already happened, and the old store is still answerable — stale, which is the
  // mirror's ordinary condition, not wrong. Propagating would tell the agent a write it
  // completed had failed.
  const reopen = async (): Promise<void> => {
    try {
      current = await open();
    } catch {
      /* keep the spent store; it is stale, not lying */
    }
  };

  return {
    getState: (): CanvasState => current.getState(),
    upsert: (shapes: CanvasShape[]): number => current.upsert(shapes),
    remove: (ids: string[]): number => current.remove(ids),
    clear: (): number => current.clear(),
    async commit(): Promise<void> {
      try {
        await current.flush();
      } finally {
        await reopen();
      }
    },
    async discard(): Promise<void> {
      await reopen();
    },
  };
}
