// The snapshot door on a canvas's room: the destination the #295 migration script
// loads into, and the source `verify` reads back.
//
// It is a request handler over a `TLSocketRoom` rather than a method on the Durable
// Object, for the reason ADR-0019 records: `CANVAS_SYNC` is an unparameterised
// `DurableObjectNamespace`, so DO RPC is unavailable and `stub.fetch` is the only way
// in. Keeping the logic here (and not inline in the DO) also makes it testable against
// a real room on `InMemorySyncStorage`, which is what its tests do.
//
// The guard that matters: POST REFUSES a room that already holds shapes. Re-running an
// import is the rollback story (old blobs are never deleted), so the destructive form
// has to be asked for explicitly — `?force=1`.

import type { RoomSnapshot, TLSocketRoom } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import { invalidRecords } from './blob-to-snapshot.ts';
import type { SyncSessionMeta } from './sync-room.ts';

type Room = TLSocketRoom<TLRecord, SyncSessionMeta>;

const shapeCount = (snapshot: RoomSnapshot): number =>
  snapshot.documents.filter((d) => d.state.typeName === 'shape').length;

/** A room snapshot has `documents`, each `{state, lastChangedClock}`. Anything else is
 *  rejected before it reaches `loadSnapshot`, which would otherwise throw INSIDE the
 *  room's transaction. */
function isRoomSnapshot(v: unknown): v is RoomSnapshot {
  const docs = (v as { documents?: unknown } | null)?.documents;
  return Array.isArray(docs) && docs.every((d) => !!d && typeof d === 'object' && 'state' in d);
}

/**
 * `GET`  → the room's current snapshot (what `verify` diffs against the blob).
 * `POST` → replace the room with the posted snapshot. 409 if the room already has
 *          shapes and `?force=1` was not passed; 400 if the body is not a snapshot.
 */
export async function handleSnapshotRequest(room: Room, request: Request): Promise<Response> {
  if (request.method === 'GET') return Response.json(room.getCurrentSnapshot());
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'body is not JSON' }, { status: 400 });
  }
  if (!isRoomSnapshot(body)) return Response.json({ error: 'body is not a room snapshot' }, { status: 400 });

  const existing = shapeCount(room.getCurrentSnapshot());
  if (existing > 0 && new URL(request.url).searchParams.get('force') !== '1') {
    return Response.json(
      { error: 'room is not empty', shapes: existing, hint: 'pass ?force=1 to replace it' },
      { status: 409 },
    );
  }

  // `isRoomSnapshot` only checks the envelope. The records themselves must be validated
  // HERE, before the load, because `loadSnapshot` does NOT validate — see
  // `invalidRecords`. Without this a malformed record is accepted silently and then
  // breaks every client that opens the room.
  const problems = invalidRecords(body);
  if (problems.length > 0) {
    return Response.json(
      { error: 'snapshot holds records this schema rejects', problems: problems.slice(0, 10), count: problems.length },
      { status: 400 },
    );
  }

  // `loadSnapshot` throws SYNCHRONOUSLY on a malformed envelope (unlike
  // `room.updateStore()`, which returns a rejecting promise — #291), and it is
  // transactional, so a refusal leaves the existing document intact. 400 rather than a
  // 500: this is a bad payload, not a broken room.
  try {
    room.loadSnapshot(body);
  } catch (e) {
    return Response.json({ error: `snapshot rejected: ${(e as Error).message}` }, { status: 400 });
  }
  return Response.json({ imported: shapeCount(body) });
}
