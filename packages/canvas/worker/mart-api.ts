// The edge mart route (ADR-0017, #238): serves a mart by name from
// `workspaces/<ws>/warehouse/`, reading the parquet IN THE WORKER via hyparquet — no
// container wake (ADR-0008). Guest scoping is the security-critical half (docstring on
// `decideMartAccess` below) — same default-deny principle as `worker/guest-gate.ts`, one
// level down: a canvas's own component instances, not the workspace's mart list.

// Imported from the browser entry, NOT `hyparquet/src/node.js` — the node entry pulls in
// `node:fs`, which is exactly the node-builtin touch the edge Worker must avoid (verified
// in real workerd with no `nodejs_compat`, ADR-0017).
import { parquetReadObjects } from 'hyparquet/src/index.js';

import { BlobStore, type BlobBackend } from '../server/blob-store.ts';
import { coerceMartRow, MartName, MartSidecarSchema, type MartSidecar } from '../shared/mart-contract.ts';
import { martsInRoomSnapshot } from '../shared/mart-scope.ts';
import { SYNC_USER_HEADER } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

/** Path this route answers: `/api/workspaces/:ws/marts/:name`. */
export const MART_ROUTE = /^\/api\/workspaces\/([^/]+)\/marts\/([^/]+)$/;

/** Minimal structural shape of a Cloudflare R2 binding's `get` (CLAUDE.md §2: narrower
 * than the full R2Bucket SDK type — only the one read this route needs). Structurally
 * compatible with the real binding, and lets tests pass a plain in-memory object. */
export interface MartBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

function r2Backend(bucket: MartBucket): BlobBackend {
  return {
    get: async (key) => {
      const obj = await bucket.get(key);
      return obj === null ? null : new Uint8Array(await obj.arrayBuffer());
    },
    put: async () => {
      throw new Error('mart-api: r2Backend is read-only');
    },
    exists: async (key) => (await bucket.get(key)) !== null,
    // This route resolves a mart the caller already NAMED (and `decideMartAccess` gates it);
    // it never enumerates. Listing would also need `MartBucket` to widen to R2's `list`, which
    // §2 says not to add for a read nobody makes. Discovery is the container's job
    // (BlobStore.listMarts), where the agent asks what exists.
    list: async () => {
      throw new Error('mart-api: r2Backend does not list');
    },
  };
}

/** Wrap whole-file bytes as the AsyncBuffer hyparquet wants. Marts are small (ADR-0017:
 * all 24 of the reference warehouse's marts total 21k rows) — no range logic needed. */
function toAsyncBuffer(bytes: Uint8Array): { byteLength: number; slice(start: number, end?: number): Promise<ArrayBuffer> } {
  return {
    byteLength: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end).buffer),
  };
}

/**
 * The guest-scoping decision — the part of this slice that matters most. Marts ARE
 * guest-readable (a shared canvas has to render), but the gate resolves the marts the
 * shared canvas's OWN component instances actually reference (`martsForGuestCanvas`, off
 * the room) and allows ONLY those. Gating on "does this guest have access to some canvas" would make
 * the entire mart namespace enumerable by anyone holding a share link pasted into Slack —
 * default-deny, same principle as `worker/guest-gate.ts`, one level down.
 *
 * A member's workspace membership is checked by the caller (index.ts, against the DB)
 * before `{ kind: 'member' }` ever reaches here — a member may then read any mart in that
 * already-authorized workspace.
 */
export function decideMartAccess(name: string, requester: MartRequester): boolean {
  if (requester.kind === 'member') return true;
  return requester.marts.has(name);
}

/** Who is asking. A guest carries the marts their canvas actually references, resolved by
 *  `martsForGuestCanvas` from the ROOM — never a name the client supplied. */
export type MartRequester = { kind: 'member' } | { kind: 'guest'; marts: Set<string> };

/** Read one mart's rows + sidecar from R2, coerced JSON-safe (ADR-0017 consequences:
 * INT64 arrives as BigInt, TIMESTAMP as Date — neither survives JSON.stringify raw).
 * `null` when either the parquet or its sidecar is missing — a mart isn't a mart without
 * its declared schema (mart-contract.ts), so a partial write reads as absent. */
export async function readMart(
  bucket: MartBucket,
  ws: string,
  name: string,
): Promise<{ sidecar: MartSidecar; rows: Record<string, unknown>[] } | null> {
  const store = new BlobStore(r2Backend(bucket));
  const [parquetBytes, rawSidecar] = await Promise.all([store.loadMart(ws, name), store.loadMartSidecar(ws, name)]);
  if (parquetBytes === null || rawSidecar === null) return null;
  const sidecar = MartSidecarSchema.parse(rawSidecar);
  const raw = await parquetReadObjects({ file: toAsyncBuffer(parquetBytes) });
  const rows = raw.map((row: Record<string, unknown>) => coerceMartRow(row));
  return { sidecar, rows };
}

/** Minimal structural shape of the `CANVAS_SYNC` Durable Object binding — same §2 narrowing
 *  as `MartBucket`: only `idFromName` + `get().fetch`, so a test can pass a plain object. */
export interface CanvasSyncNamespace<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): { fetch(request: Request): Promise<Response> };
}

/**
 * The guest branch's input to `decideMartAccess`: which marts THIS canvas references,
 * read from its sync room (ADR-0019, #289).
 *
 * This used to read `canvas-state.json` off R2 on the premise that R2 was canvas state's
 * source of truth. The Durable Object room is now that source, so the blob is stale and
 * authorizing against it would keep serving a mart whose shape has been deleted from the
 * canvas — a security-relevant staleness. Having the DO write an R2 snapshot for cold
 * readers instead was rejected in ADR-0019: two representations of one fact.
 *
 * `readerId` is stamped into `SYNC_USER_HEADER` AFTER the caller has authorized the guest
 * against the live share link, exactly as every other door onto a room does it — the room
 * requires an identity and the client can never supply one.
 *
 * Fails closed: a room that does not answer grants no marts.
 */
export async function martsForGuestCanvas(
  sync: CanvasSyncNamespace,
  canvasId: string,
  readerId: string,
): Promise<Set<string>> {
  const stub = sync.get(sync.idFromName(syncRoomName(canvasId)));
  const res = await stub.fetch(
    new Request(`https://canvas-sync/api/canvas-sync/${canvasId}/snapshot`, {
      headers: { [SYNC_USER_HEADER]: readerId },
    }),
  );
  if (!res.ok) return new Set();
  return martsInRoomSnapshot((await res.json()) as { documents: { state: unknown }[] });
}

const NOT_FOUND = () => Response.json({ error: 'not found' }, { status: 404 });

/** The full route: reject a malformed name (`MartName`, mart-contract.ts) with the SAME
 * 404 as denied/absent — a bad name must not be distinguishable from a real-but-missing or
 * real-but-denied one, or the shape itself becomes an oracle. Then default-deny via
 * `decideMartAccess`, then a read that 404s identically whether the mart is genuinely
 * absent or the requester was denied — a guest learns nothing about whether an
 * unreferenced name is real (ADR-0017: no enumeration). Validating BEFORE it ever reaches
 * `martKey`/`martSidecarKey` (blob-store.ts) matters beyond this route: a filesystem-backed
 * `BlobBackend` builds paths with `join()`, and an unvalidated name is exactly the shape
 * that becomes a traversal bug the moment such a reader exists. */
export async function handleMartApi(
  bucket: MartBucket,
  ws: string,
  name: string,
  requester: MartRequester,
): Promise<Response> {
  if (!MartName.safeParse(name).success) return NOT_FOUND();
  if (!decideMartAccess(name, requester)) return NOT_FOUND();
  const mart = await readMart(bucket, ws, name);
  if (mart === null) return NOT_FOUND();
  return Response.json(mart);
}
