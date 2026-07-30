// Blob store for canvas persistence. Two concerns, kept dumb: deterministic key
// layout, and a swappable `BlobBackend`. The backend is the ONLY thing that
// knows where bytes live — local disk for dev (no cloud), R2 in the container,
// an in-memory Map in tests. No policy lives here. Glossary: workspace = container/fs;
// canvas = board. (The canvas-state data-loss guard that used to sit above this in
// `canvas-persistence.ts` went with the old sync plane — ADR-0019 / #297. The canvas key
// and its READER stay: the retained blobs are the cutover's import source.)
//
// NOTHING HERE HOLDS WORKSPACE CONTENT any more (#366, ADR-0022). What is left is chat meta,
// the retained canvas-state blobs, and the warehouse's mart artifacts — plus the raw backend,
// which `transcript-store.ts` uses for its own per-session keys.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type MartSidecar, MartSidecarSchema } from '../shared/mart-contract.ts';
import type { CanvasState } from '../src/shapes.ts';
import type { ChatMeta } from './chat-meta.ts';

/** Sidecar filename suffix — `martSidecarKey`'s tail, factored out so listing can strip it. */
const SIDECAR_SUFFIX = '.schema.json';

/** workspace-scoped per-canvas board state. */
export const canvasStateKey = (ws: string, canvas: string): string =>
  `workspaces/${ws}/canvases/${canvas}/canvas-state.json`;

// Workspace CONTENT used to live here as three tarballs — `shared-components.tar`,
// `canvas-components.tar` and `skills.tar`. Components, their data files and Workspace skills
// are Records in D1 now (ADR-0022), and #366 removed the keys with the sinks that wrote them:
// each save was a full replace of one key, so an empty source tree could — and on 2026-07-29
// did — delete a workspace's authored content in a single flush. The objects are still in the
// bucket, frozen, as the pre-migration rollback; the only code that names them is the backfill's
// read-only survey (`record-migration.ts`), which spells its own keys out for that reason.
//
// Session transcripts used to live here as `workspaces/<ws>/sessions.tar`. They are FILES, not
// Records (CONTEXT.md → Record vs File), and since #356 each session is its own opaque object —
// `transcript-store.ts` owns that key layout. The tar was a full replace of the whole
// ~/.claude/projects tree on every turn: 49,111,040 bytes in production against ~650 KB of
// appends, re-downloaded at every cold boot.

/** workspace-scoped mart parquet artifact (ADR-0017): `workspaces/<ws>/warehouse/<name>.parquet`.
 * The declared-schema sidecar lives next to it at `<name>.schema.json` (mart-contract.ts). */
export const martKey = (ws: string, name: string): string => `workspaces/${ws}/warehouse/${name}.parquet`;
export const martSidecarKey = (ws: string, name: string): string => `workspaces/${ws}/warehouse/${name}.schema.json`;

/** workspace-scoped per-chat durable state (ADR 0004): the `chatId → ChatMeta` map,
 * one JSON blob for the whole workspace. Replaces browser `localStorage` as the home for
 * `{ sessionId, model, effort, forkNext }`. */
export const chatMetaKey = (ws: string): string => `workspaces/${ws}/chat-meta.json`;

/** workspace-scoped warehouse prefix — every mart artifact for `ws` lives under it. */
export const warehousePrefix = (ws: string): string => `workspaces/${ws}/warehouse/`;

/** Minimal blob seam. `get` returns null for an absent key (legitimately empty),
 * and throws only on a real backend failure — the two are distinct. `list` returns full
 * keys under `prefix` (empty array when nothing matches — an absent prefix is not an
 * error), and is the only way to discover marts a caller can't already name. */
export interface BlobBackend {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

/** In-memory backend for tests. */
export const memBackend = (): BlobBackend => {
  const map = new Map<string, Uint8Array>();
  return {
    get: async (key) => map.get(key) ?? null,
    put: async (key, data) => void map.set(key, data),
    exists: async (key) => map.has(key),
    list: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
};

/** Local-filesystem backend for dev. Keys (with `/`) map to paths under `root`;
 * Bun.write creates parent dirs. No network, no cloud. */
export const fsBackend = (root: string): BlobBackend => ({
  get: async (key) => {
    const f = Bun.file(join(root, key));
    return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
  },
  put: async (key, data) => void (await Bun.write(join(root, key), data)),
  exists: (key) => Bun.file(join(root, key)).exists(),
  // A prefix maps to a directory here; an absent one means "nothing stored yet", not a
  // failure, so ENOENT is the empty listing (matching `get`'s null-for-absent contract).
  list: async (prefix) => {
    try {
      const names = await readdir(join(root, prefix));
      return names.map((n) => `${prefix}${n}`);
    } catch {
      return [];
    }
  },
});

/** Prod backend: R2 via Bun's S3-compatible client. Creds read from env at the
 * call site (no central config). Untested here — exercised by the deploy. */
export const s3Backend = (): BlobBackend => {
  const client = new Bun.S3Client({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    endpoint: process.env.R2_ENDPOINT,
  });
  return {
    get: async (key) => {
      const f = client.file(key);
      if (!(await f.exists())) return null;
      return new Uint8Array(await f.arrayBuffer());
    },
    put: async (key, data) => void (await client.file(key).write(data)),
    exists: (key) => client.file(key).exists(),
    // R2 is flat: `prefix` is a literal key prefix, not a directory. `contents` is absent
    // (not empty) when nothing matches.
    list: async (prefix) => {
      const res = await client.list({ prefix });
      return (res?.contents ?? []).map((o) => o.key);
    },
  };
};

/** Pick a backend from env: `R2_BUCKET` set → R2, else local disk at `fsRoot`. */
export const selectBackend = (fsRoot: string): BlobBackend =>
  process.env.R2_BUCKET ? s3Backend() : fsBackend(fsRoot);

const enc = new TextEncoder();
const dec = new TextDecoder();

export class BlobStore {
  constructor(private readonly backend: BlobBackend) {}

  /**
   * READ-ONLY since ADR-0019 / #297. The canvas document lives in the room now, so nothing
   * writes `canvas-state.json` any more — but the retained blobs are exactly what the
   * production cutover imports (`scripts/migrate-canvas-rooms.ts`, #295) and what a
   * rollback re-imports. The reader survives on purpose; only the writer was deleted.
   */
  async loadCanvasState(ws: string, canvas: string): Promise<CanvasState | null> {
    const bytes = await this.backend.get(canvasStateKey(ws, canvas));
    return bytes === null ? null : (JSON.parse(dec.decode(bytes)) as CanvasState);
  }

  async loadChatMeta(ws: string): Promise<Record<string, ChatMeta> | null> {
    const bytes = await this.backend.get(chatMetaKey(ws));
    return bytes === null ? null : (JSON.parse(dec.decode(bytes)) as Record<string, ChatMeta>);
  }

  async saveChatMeta(ws: string, map: Record<string, ChatMeta>): Promise<void> {
    await this.backend.put(chatMetaKey(ws), enc.encode(JSON.stringify(map)));
  }

  loadMart(ws: string, name: string): Promise<Uint8Array | null> {
    return this.backend.get(martKey(ws, name));
  }

  async saveMart(ws: string, name: string, bytes: Uint8Array): Promise<void> {
    await this.backend.put(martKey(ws, name), bytes);
  }

  async loadMartSidecar(ws: string, name: string): Promise<unknown | null> {
    const bytes = await this.backend.get(martSidecarKey(ws, name));
    return bytes === null ? null : JSON.parse(dec.decode(bytes));
  }

  async saveMartSidecar(ws: string, name: string, sidecar: unknown): Promise<void> {
    await this.backend.put(martSidecarKey(ws, name), enc.encode(JSON.stringify(sidecar)));
  }

  /** Every materialized mart in the workspace, as its parsed sidecar — the discovery seam
   * the chat agent needs to know a mart EXISTS and what columns it has (without this it can
   * only guess a name, and a wrong guess renders an empty component that looks like "no data
   * yet"). Keys off `.schema.json`, not the parquet: a mart is not a mart without its
   * declared schema (mart-contract.ts), so a parquet with no sidecar is not listable.
   * A malformed sidecar is SKIPPED rather than thrown, so one bad artifact can't blind the
   * agent to every other mart. */
  async listMarts(ws: string): Promise<MartSidecar[]> {
    const prefix = warehousePrefix(ws);
    const keys = (await this.backend.list(prefix)).filter((k) => k.endsWith(SIDECAR_SUFFIX));
    const names = keys.map((k) => k.slice(prefix.length, -SIDECAR_SUFFIX.length));
    const parsed = await Promise.all(
      names.map(async (name) => {
        const raw = await this.loadMartSidecar(ws, name);
        const result = MartSidecarSchema.safeParse(raw);
        return result.success ? result.data : null;
      }),
    );
    return parsed.filter((m): m is MartSidecar => m !== null);
  }
}
