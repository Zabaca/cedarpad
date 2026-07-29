// The Record persistence port (ADR-0022). Records — Component source and their data
// files — are the truth; the container filesystem is a rendering of them. This file is
// the seam between "what a Record is" and "where the rows live", and it deliberately
// mirrors `server/blob-store.ts`'s `BlobBackend` / `memBackend` shape: one interface,
// an in-memory implementation for tests, a real one for production.
//
// The port is intentionally dumb — no tier resolution, no name validation, no ownership.
// Those are policy and live in `component-store.ts` above it.

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../web-poc/lib/db/index.ts';
import { componentRecordVersions, componentRecords } from '../web-poc/lib/db/schema.ts';

/** The three coordinates that name a Record. `canvasId: null` is the workspace SHARED tier. */
export type RecordKey = { workspaceId: string; canvasId: string | null; name: string };

/** Component source vs a data file a Component imports. Same table, different door. */
export type RecordKind = 'component' | 'data';

export type RecordRow = RecordKey & {
  kind: RecordKind;
  source: string;
  /** Monotonic per Record, starting at 1 — also the `version` of the row this write appended. */
  rev: number;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
};

export type RecordVersionRow = RecordKey & {
  version: number;
  source: string;
  createdAt: Date;
  createdBy: string | null;
};

/** What a `put` names: the key, the content, and who is doing it. `rev` is the store's
 *  to assign — a caller that could choose it could overwrite a version. */
export type RecordPut = RecordKey & { kind: RecordKind; source: string; updatedBy: string | null };

export type RecordScope = { workspaceId: string; canvasId: string | null };

/**
 * The persistence port. Every write APPENDS A VERSION — that is an invariant of the store,
 * not a courtesy of its callers, because the 2026-07-29 loss was a full replace with no
 * history and a caller that forgets is exactly how that comes back.
 *
 * Deletion is always SOFT here: `softDelete` hides a Record from `get`/`list` while its
 * versions survive. Reclaiming rows is an explicit purge, which this port deliberately
 * does not offer — one click must never destroy source.
 */
export interface RecordStore {
  /** Create or overwrite a Record, bumping `rev` and appending a version. Undeletes. */
  put(input: RecordPut): Promise<RecordRow>;
  /** The live Record, or null when it never existed or is soft-deleted. */
  get(key: RecordKey): Promise<RecordRow | null>;
  /** Every live Record in one tier of one workspace, by name. */
  list(scope: RecordScope): Promise<RecordRow[]>;
  /** A Record's history, newest first. Survives a soft delete. */
  listVersions(key: RecordKey): Promise<RecordVersionRow[]>;
  /** ONE version, with its source — what a restore reads (#362). Null when that Record has
   *  no such version. Separate from `listVersions` because every version row carries a full
   *  source: fetching them all to keep one would drag the whole corpus of a long-cared-for
   *  Component through memory to answer a question about a single revision. */
  getVersion(key: RecordKey, version: number): Promise<RecordVersionRow | null>;
  /**
   * Change a live Record's TIER — the whole of it, history included — and append a version
   * recording the move. What `promote` is made of.
   *
   * The source row is *relocated*, never copied-then-deleted, so there is no instant at which
   * the Record is in both tiers or in neither. That is not fastidiousness: a promote whose
   * shared write was lost after the own copy had gone made placed instances resolve to a
   * same-named PLATFORM component and render a plausible, wrong card — silent substitution,
   * which is strictly worse than a 404.
   *
   * Throws when the source is absent (or soft-deleted) and when the destination name is
   * already taken, so a caller can never widen it into a silent overwrite.
   */
  move(from: RecordKey, to: RecordKey, updatedBy: string | null): Promise<RecordRow>;
  /** Hide one Record. Absent key: a no-op, not an error. */
  softDelete(key: RecordKey): Promise<void>;
  /** Hide every Record in one tier — what deleting a canvas does to its own tier. */
  softDeleteScope(scope: RecordScope): Promise<void>;
}

/** Map key: the three coordinates, with a sentinel for the shared tier's null canvas. */
const keyOf = (k: RecordKey): string => `${k.workspaceId}\0${k.canvasId ?? ''}\0${k.name}`;
const scopeOf = (s: RecordScope): string => `${s.workspaceId}\0${s.canvasId ?? ''}\0`;

/** In-memory implementation for tests — the `memBackend()` precedent. No database. */
export const memRecordStore = (): RecordStore => {
  const rows = new Map<string, RecordRow>();
  const versions = new Map<string, RecordVersionRow[]>();
  return {
    put: async (input) => {
      const id = keyOf(input);
      const now = new Date();
      const rev = (rows.get(id)?.rev ?? 0) + 1;
      const row: RecordRow = { ...input, rev, updatedAt: now, deletedAt: null };
      rows.set(id, row);
      versions.set(id, [
        ...(versions.get(id) ?? []),
        { workspaceId: input.workspaceId, canvasId: input.canvasId, name: input.name, version: rev, source: input.source, createdAt: now, createdBy: input.updatedBy },
      ]);
      return row;
    },
    get: async (key) => {
      const row = rows.get(keyOf(key));
      return row && row.deletedAt === null ? row : null;
    },
    list: async (scope) =>
      [...rows.values()]
        .filter((r) => keyOf(r).startsWith(scopeOf(scope)) && r.deletedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    listVersions: async (key) => [...(versions.get(keyOf(key)) ?? [])].sort((a, b) => b.version - a.version),
    getVersion: async (key, version) => (versions.get(keyOf(key)) ?? []).find((v) => v.version === version) ?? null,
    move: async (from, to, updatedBy) => {
      const [fromId, toId] = [keyOf(from), keyOf(to)];
      const row = rows.get(fromId);
      if (!row || row.deletedAt !== null) throw new Error(`no Record "${from.name}" to move`);
      if (rows.get(toId)) throw new Error(`a Record "${to.name}" already exists there`);
      const now = new Date();
      const moved: RecordRow = { ...row, ...to, rev: row.rev + 1, updatedAt: now, updatedBy, deletedAt: null };
      rows.delete(fromId);
      rows.set(toId, moved);
      versions.set(toId, [
        ...(versions.get(fromId) ?? []).map((v) => ({ ...v, workspaceId: to.workspaceId, canvasId: to.canvasId, name: to.name })),
        { ...to, version: moved.rev, source: moved.source, createdAt: now, createdBy: updatedBy },
      ]);
      versions.delete(fromId);
      return moved;
    },
    softDelete: async (key) => {
      const row = rows.get(keyOf(key));
      if (row) rows.set(keyOf(key), { ...row, deletedAt: new Date() });
    },
    softDeleteScope: async (scope) => {
      for (const [id, row] of rows) {
        if (id.startsWith(scopeOf(scope)) && row.deletedAt === null) rows.set(id, { ...row, deletedAt: new Date() });
      }
    },
  };
};

/**
 * The real implementation: rows in D1 (ADR-0022 decision 3). D1 chose itself by its limits —
 * a 2 MB max row/string fits a 20 KB Component or a 1 MB data file, and 30-day Time Travel is
 * a floor under the whole database that R2 has no equivalent for.
 *
 * Every value below is a BOUND PARAMETER (drizzle always binds). That is not a style
 * preference: D1's maximum SQL *statement* is 100 KB, so a source interpolated into the
 * statement would fail outright well before the row limit.
 */
export const d1RecordStore = (db: Database): RecordStore => {
  const canvasEq = (canvasId: string | null) =>
    canvasId === null ? isNull(componentRecords.canvasId) : eq(componentRecords.canvasId, canvasId);
  const keyWhere = (k: RecordKey) =>
    and(eq(componentRecords.workspaceId, k.workspaceId), canvasEq(k.canvasId), eq(componentRecords.name, k.name));
  const versionKeyWhere = (k: RecordKey) =>
    and(
      eq(componentRecordVersions.workspaceId, k.workspaceId),
      k.canvasId === null ? isNull(componentRecordVersions.canvasId) : eq(componentRecordVersions.canvasId, k.canvasId),
      eq(componentRecordVersions.name, k.name),
    );

  /** The row INCLUDING a soft-deleted one — `put` needs the buried rev to keep history monotonic. */
  const rowOf = async (key: RecordKey) =>
    (await db.select().from(componentRecords).where(keyWhere(key)).limit(1))[0] ?? null;

  return {
    put: async (input) => {
      const { source, kind, updatedBy, ...key } = input;
      const existing = await rowOf(key);
      const rev = (existing?.rev ?? 0) + 1;
      const updatedAt = new Date();
      const row: RecordRow = { ...key, kind, source, rev, updatedAt, updatedBy, deletedAt: null };
      // Row first, then history. A failure between the two costs one history entry and never
      // the source — the opposite order would leave `listVersions` claiming a source the
      // Record does not have, which is the more confusing direction to debug.
      if (existing) {
        await db
          .update(componentRecords)
          .set({ kind, source, rev, updatedAt, updatedBy, deletedAt: null })
          .where(keyWhere(key));
      } else {
        await db.insert(componentRecords).values(row);
      }
      await db
        .insert(componentRecordVersions)
        .values({ ...key, version: rev, source, createdAt: updatedAt, createdBy: updatedBy });
      return row;
    },

    get: async (key) => {
      const row = await rowOf(key);
      return row && row.deletedAt === null ? row : null;
    },

    list: async (scope) =>
      await db
        .select()
        .from(componentRecords)
        .where(
          and(
            eq(componentRecords.workspaceId, scope.workspaceId),
            canvasEq(scope.canvasId),
            isNull(componentRecords.deletedAt),
          ),
        )
        .orderBy(asc(componentRecords.name)),

    listVersions: async (key) =>
      await db.select().from(componentRecordVersions).where(versionKeyWhere(key)).orderBy(desc(componentRecordVersions.version)),

    getVersion: async (key, version) =>
      (
        await db
          .select()
          .from(componentRecordVersions)
          .where(and(versionKeyWhere(key), eq(componentRecordVersions.version, version)))
          .limit(1)
      )[0] ?? null,

    move: async (from, to, updatedBy) => {
      const row = await rowOf(from);
      if (!row || row.deletedAt !== null) throw new Error(`no Record "${from.name}" to move`);
      if (await rowOf(to)) throw new Error(`a Record "${to.name}" already exists there`);
      const moved: RecordRow = { ...row, ...to, rev: row.rev + 1, updatedAt: new Date(), updatedBy, deletedAt: null };
      // ONE statement relocates the row, so the Record is in exactly one tier at every
      // instant — the property the filesystem move could never give us.
      await db.update(componentRecords).set(moved).where(keyWhere(from));
      // Then the history follows it: a Component's past belongs to the Component, not to the
      // tier it happened to sit in, so a restore after a promote still has something to restore.
      await db.update(componentRecordVersions).set(to).where(versionKeyWhere(from));
      await db
        .insert(componentRecordVersions)
        .values({ ...to, version: moved.rev, source: moved.source, createdAt: moved.updatedAt, createdBy: updatedBy });
      return moved;
    },

    softDelete: async (key) => {
      await db
        .update(componentRecords)
        .set({ deletedAt: new Date() })
        .where(and(keyWhere(key), isNull(componentRecords.deletedAt)));
    },

    softDeleteScope: async (scope) => {
      await db
        .update(componentRecords)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(componentRecords.workspaceId, scope.workspaceId),
            canvasEq(scope.canvasId),
            isNull(componentRecords.deletedAt),
          ),
        );
    },
  };
};
