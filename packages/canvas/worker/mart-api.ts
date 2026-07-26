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
import { coerceMartRow, MartSidecarSchema, type MartSidecar } from '../shared/mart-contract.ts';
import { martsReferencedBy } from '../shared/mart-scope.ts';
import type { CanvasState } from '../src/shapes.ts';

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
 * shared canvas's OWN component instances actually reference (`martsReferencedBy`) and
 * allows ONLY those. Gating on "does this guest have access to some canvas" would make
 * the entire mart namespace enumerable by anyone holding a share link pasted into Slack —
 * default-deny, same principle as `worker/guest-gate.ts`, one level down.
 *
 * A member's workspace membership is checked by the caller (index.ts, against the DB)
 * before `{ kind: 'member' }` ever reaches here — a member may then read any mart in that
 * already-authorized workspace.
 */
export function decideMartAccess(
  name: string,
  requester: { kind: 'member' } | { kind: 'guest'; canvasState: CanvasState },
): boolean {
  if (requester.kind === 'member') return true;
  return martsReferencedBy(requester.canvasState).has(name);
}

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

/** Read a canvas's current state straight off R2 (never the container/bridge) — the guest
 * branch's input to `martsReferencedBy`. Canvas state's source of truth is R2 (the
 * container is a cache that saves back to it), so this is safe to read cold, same as the
 * mart itself; it's what makes "browsing never wakes the container" hold for the guest
 * path too. `null` if the canvas has no persisted state yet. */
export async function loadCanvasStateFromBucket(bucket: MartBucket, ws: string, canvasId: string): Promise<CanvasState | null> {
  const store = new BlobStore(r2Backend(bucket));
  return store.loadCanvasState(ws, canvasId);
}

const NOT_FOUND = () => Response.json({ error: 'not found' }, { status: 404 });

/** The full route: default-deny via `decideMartAccess`, then a read that 404s identically
 * whether the mart is genuinely absent or the requester was denied — a guest learns
 * nothing about whether an unreferenced name is real (ADR-0017: no enumeration). */
export async function handleMartApi(
  bucket: MartBucket,
  ws: string,
  name: string,
  requester: { kind: 'member' } | { kind: 'guest'; canvasState: CanvasState },
): Promise<Response> {
  if (!decideMartAccess(name, requester)) return NOT_FOUND();
  const mart = await readMart(bucket, ws, name);
  if (mart === null) return NOT_FOUND();
  return Response.json(mart);
}
