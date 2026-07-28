// The canvas sync room: one `TLSocketRoom` per canvas, hosted in a Durable Object,
// persisted to DO SQLite (ADR-0019). Shape follows tldraw's official
// `tldraw/tldraw-sync-cloudflare` template, with two differences that are ours:
//   - the schema comes from `createCanvasTLSchema()` (src/tl-schema.ts) — the SAME
//     factory the browser client builds from, so the two can never drift (CLAUDE.md §7);
//   - persistence is DO SQLite via sync-core's own `SQLiteSyncStorage`, not an R2
//     snapshot blob (the template's choice). See ADR-0019 "single-blob persistence".

import { TLSocketRoom, type TLSocketRoomOptions } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import { createCanvasTLSchema } from '../src/tl-schema.ts';

/** Per-session metadata the room carries. `userId` is the authenticated member (or the
 *  guest's link owner); it is stamped by the Worker at the upgrade, never by the client. */
export interface SyncSessionMeta {
  userId: string;
}

/**
 * A `TLSocketRoom` on THIS app's schema. The schema is the only thing that must not vary
 * between the browser client and the room, so it is not a parameter — everything else
 * (storage, hibernation hooks) is passed through by the caller.
 */
export function createCanvasSyncRoom(
  opts: Omit<TLSocketRoomOptions<TLRecord, SyncSessionMeta>, 'schema'> = {},
): TLSocketRoom<TLRecord, SyncSessionMeta> {
  return new TLSocketRoom<TLRecord, SyncSessionMeta>({
    ...opts,
    schema: createCanvasTLSchema(),
  });
}

/**
 * The Durable Object *name* for a canvas's room. `idFromName` then maps it to a
 * deterministic id, which is what makes "exactly one room per canvas, globally" true:
 * every Worker isolate in every colo derives the same id from the same canvas.
 *
 * Namespaced so a canvas id can never collide with some other future use of this
 * namespace, and kept as the raw canvas id (not a hash) so a DO in the dashboard is
 * traceable back to its canvas.
 */
export function syncRoomName(canvasId: string): string {
  return `canvas:${canvasId}`;
}
