// A `CanvasStore` backed by the canvas's Durable-Object-hosted sync room (ADR-0019,
// #291) — the second half of the agent write path.
//
// WHY IT IS STILL SYNCHRONOUS: `CanvasStore` is the seam, and every agent tool in
// canvas-ops.ts consumes it synchronously. Re-backing that interface onto an HTTP
// endpoint without changing a single caller means the store is a MIRROR plus a queue:
// reads answer from the snapshot the room handed us on open, mutations apply locally and
// are recorded, and `flush()` sends them in order and re-seeds the mirror from the room's
// authoritative reply. Making the interface async instead would have rewritten
// canvas-ops.ts — the exact outcome ADR-0019 says this seam exists to avoid.
//
// The mirror is a read-modify-write window, and that is sound here for the same reason
// the old store was: mutations are absolute upsert-by-id and delete-by-id, so a concurrent
// human edit to a DIFFERENT shape is untouched, and to the SAME shape it is
// last-writer-wins — unchanged from the behaviour this replaces. The window is one
// tool call wide.

import { CanvasMutation, CanvasMutationResult, type CanvasMutationResult as Result } from '../shared/canvas-mutation';
import type { CanvasShape, CanvasState } from './shapes';
import { createStore, type CanvasStore } from './store';

export interface RemoteCanvasStore extends CanvasStore {
  /** Send every mutation recorded since the last flush, in order, and adopt the room's
   *  post-state. Rejects with the room's own reason if a write was refused. */
  flush(): Promise<void>;
}

/** Thrown when the endpoint refuses a mutation — carries the room's message verbatim so
 *  an agent sees why its intent was wrong, not a generic HTTP failure. */
export class RemoteStoreError extends Error {}

async function send(endpoint: string, fetchImpl: typeof fetch, mutation: CanvasMutation, headers: Record<string, string>): Promise<Result> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    // Parse on the way OUT as well as on the way in: the contract is the only thing that
    // may cross this boundary, in either direction (CLAUDE.md §7).
    body: JSON.stringify(CanvasMutation.parse(mutation)),
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new RemoteStoreError(body?.error ?? `canvas mutation failed (${res.status})`);
  return CanvasMutationResult.parse(body);
}

/**
 * Open a store on a canvas's room. The single `read` this performs is the snapshot the
 * synchronous interface answers from until the next `flush()`.
 */
export async function openRemoteCanvasStore(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<RemoteCanvasStore> {
  let state = await send(endpoint, fetchImpl, { op: 'read' }, headers);
  let mirror = createStore(state.shapes);
  let queue: CanvasMutation[] = [];

  const adopt = (next: Result) => {
    state = next;
    mirror = createStore(next.shapes);
  };

  return {
    getState(): CanvasState {
      // The room's clock, not the mirror's local counter: the version an agent observes
      // has to be the one the room and every browser client agree on.
      return { version: state.version, shapes: mirror.getState().shapes };
    },
    upsert(shapes: CanvasShape[]): number {
      const v = mirror.upsert(shapes);
      if (shapes.length) queue.push({ op: 'upsert', shapes });
      return v;
    },
    remove(ids: string[]): number {
      const v = mirror.remove(ids);
      if (ids.length) queue.push({ op: 'remove', ids });
      return v;
    },
    clear(): number {
      const v = mirror.clear();
      queue.push({ op: 'clear' });
      return v;
    },
    async flush(): Promise<void> {
      const pending = queue;
      queue = [];
      // Sequential, never concurrent: the ops are ordered (a create then a delete of the
      // same id is not the same as the reverse) and the room applies them as it gets them.
      for (const m of pending) adopt(await send(endpoint, fetchImpl, m, headers));
    },
  };
}
