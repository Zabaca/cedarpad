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
  // #327 removed the id-counter priming that used to happen here. Minted ids are random
  // now (src/normalize.ts), so there is nothing to prime FROM and nothing to prime: an id
  // that no other writer can produce does not need to be told what the room already holds.
  let mirror = createStore(state.shapes);
  let queue: CanvasMutation[] = [];
  let poison: RemoteStoreError | null = null;

  const adopt = (next: Result) => {
    state = next;
    mirror = createStore(next.shapes);
  };

  // A failed flush POISONS the store: every later call throws instead of answering.
  //
  // The batch is not atomic — the ops go one at a time — so a failure partway through
  // leaves the room holding a PREFIX of what the mirror has applied. That makes the
  // mirror wrong for reads, not just for writes, and no local recovery can fix it: we
  // cannot know whether the failed op landed, and the ops after it were never sent. The
  // alternative (re-queue the remainder and let the caller retry) quietly re-offers a
  // mirror we already know disagrees with the room, which is exactly how "the agent says
  // it drew the thing and the canvas disagrees" becomes expensive to trace. Failing loud
  // and early is cheaper. The caller's recovery is to open a fresh store, which re-reads
  // the room's actual state.
  const live = <T>(fn: () => T): T => {
    if (poison) throw poison;
    return fn();
  };

  return {
    getState(): CanvasState {
      // The room's clock, not the mirror's local counter: the version an agent observes
      // has to be the one the room and every browser client agree on.
      return live(() => ({ version: state.version, shapes: mirror.getState().shapes }));
    },
    upsert(shapes: CanvasShape[]): number {
      return live(() => {
        const v = mirror.upsert(shapes);
        if (shapes.length) queue.push({ op: 'upsert', shapes });
        return v;
      });
    },
    remove(ids: string[]): number {
      return live(() => {
        const v = mirror.remove(ids);
        if (ids.length) queue.push({ op: 'remove', ids });
        return v;
      });
    },
    clear(): number {
      return live(() => {
        const v = mirror.clear();
        queue.push({ op: 'clear' });
        return v;
      });
    },
    async flush(): Promise<void> {
      if (poison) throw poison;
      const pending = queue;
      queue = [];
      // Sequential, never concurrent: the ops are ordered (a create then a delete of the
      // same id is not the same as the reverse) and the room applies them as it gets them.
      for (let i = 0; i < pending.length; i++) {
        try {
          adopt(await send(endpoint, fetchImpl, pending[i]!, headers));
        } catch (e) {
          const unsent = pending.length - i - 1;
          poison = new RemoteStoreError(
            `canvas mutation ${i + 1}/${pending.length} failed, ${unsent} later mutation(s) not sent — this store is now unusable, reopen it: ${
              (e as Error).message
            }`,
          );
          throw poison;
        }
      }
    },
  };
}
