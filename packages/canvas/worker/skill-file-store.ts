// The Workspace-skill persistence port (ADR-0022). Sibling of `record-store.ts`, and separate
// from it for one reason: a skill is a DIRECTORY, so its key is two-level — the skill, then the
// path inside it — where a Component's is (workspace, canvas, name). Same shape otherwise: one
// interface, an in-memory implementation for tests, a D1-backed one for production.
//
// The port is intentionally dumb — no name rules, no path rules, no ownership. Those are policy
// and live in `skill-store.ts` above it.

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../web-poc/lib/db/index.ts';
import { skillFileVersions, skillFiles } from '../web-poc/lib/db/schema.ts';

/** The three coordinates that name one file of one Workspace skill. */
export type SkillFileKey = { workspaceId: string; skill: string; path: string };

export type SkillFileRow = SkillFileKey & {
  content: string;
  /** Monotonic per file, starting at 1 — also the `version` of the row this write appended. */
  rev: number;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
};

export type SkillFileVersionRow = SkillFileKey & {
  version: number;
  content: string;
  createdAt: Date;
  createdBy: string | null;
};

export type SkillFilePut = SkillFileKey & { content: string; updatedBy: string | null };

/**
 * The persistence port. Every write APPENDS A VERSION, exactly as `RecordStore` does — the
 * 2026-07-29 loss was a full replace with no history, and a caller that forgets is how that
 * comes back.
 *
 * `list` is workspace-wide rather than per-skill on purpose: the SDK discovers skills by
 * SCANNING a directory tree, so the only question materialization ever asks is "what is this
 * workspace's whole skill tree?".
 */
export interface SkillFileStore {
  /** Create or overwrite one file, bumping `rev` and appending a version. */
  put(input: SkillFilePut): Promise<SkillFileRow>;
  /** Every live skill file in one workspace, ordered by skill then path. */
  list(workspaceId: string): Promise<SkillFileRow[]>;
  /** One file's history, newest first. */
  listVersions(key: SkillFileKey): Promise<SkillFileVersionRow[]>;
}

const keyOf = (k: SkillFileKey): string => `${k.workspaceId} ${k.skill} ${k.path}`;
/** Plain codepoint order, NOT `localeCompare` — this has to agree with SQLite's `ORDER BY`,
 *  or the two implementations would answer the same question in two different orders. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const bySkillThenPath = (a: SkillFileKey, b: SkillFileKey): number => cmp(a.skill, b.skill) || cmp(a.path, b.path);

/** In-memory implementation for tests — the `memBackend()` / `memRecordStore()` precedent. */
export const memSkillFileStore = (): SkillFileStore => {
  const rows = new Map<string, SkillFileRow>();
  const versions = new Map<string, SkillFileVersionRow[]>();
  return {
    put: async (input) => {
      const id = keyOf(input);
      const now = new Date();
      const rev = (rows.get(id)?.rev ?? 0) + 1;
      const row: SkillFileRow = { ...input, rev, updatedAt: now, deletedAt: null };
      rows.set(id, row);
      versions.set(id, [
        ...(versions.get(id) ?? []),
        {
          workspaceId: input.workspaceId,
          skill: input.skill,
          path: input.path,
          version: rev,
          content: input.content,
          createdAt: now,
          createdBy: input.updatedBy,
        },
      ]);
      return row;
    },
    list: async (workspaceId) =>
      [...rows.values()].filter((r) => r.workspaceId === workspaceId && r.deletedAt === null).sort(bySkillThenPath),
    listVersions: async (key) => [...(versions.get(keyOf(key)) ?? [])].sort((a, b) => b.version - a.version),
  };
};

/**
 * The real implementation: rows in D1 (ADR-0022 decision 3), sibling of `d1RecordStore`.
 *
 * Every value below is a BOUND PARAMETER (drizzle always binds) — not a style preference:
 * D1's maximum SQL *statement* is 100 KB, so a skill file interpolated into the statement
 * would fail well before the 2 MB row limit the contract's per-file cap sits under.
 */
export const d1SkillFileStore = (db: Database): SkillFileStore => {
  const keyWhere = (k: SkillFileKey) =>
    and(eq(skillFiles.workspaceId, k.workspaceId), eq(skillFiles.skill, k.skill), eq(skillFiles.path, k.path));

  /** The row INCLUDING a soft-deleted one — `put` needs the buried rev to keep history monotonic. */
  const rowOf = async (key: SkillFileKey) => (await db.select().from(skillFiles).where(keyWhere(key)).limit(1))[0] ?? null;

  return {
    put: async (input) => {
      const { content, updatedBy, ...key } = input;
      const existing = await rowOf(key);
      const rev = (existing?.rev ?? 0) + 1;
      const updatedAt = new Date();
      const row: SkillFileRow = { ...key, content, rev, updatedAt, updatedBy, deletedAt: null };
      // Row first, then history — the same order `d1RecordStore` uses, for the same reason:
      // a failure between the two costs one history entry and never the content.
      if (existing) {
        await db.update(skillFiles).set({ content, rev, updatedAt, updatedBy, deletedAt: null }).where(keyWhere(key));
      } else {
        await db.insert(skillFiles).values(row);
      }
      await db.insert(skillFileVersions).values({ ...key, version: rev, content, createdAt: updatedAt, createdBy: updatedBy });
      return row;
    },

    list: async (workspaceId) =>
      await db
        .select()
        .from(skillFiles)
        .where(and(eq(skillFiles.workspaceId, workspaceId), isNull(skillFiles.deletedAt)))
        .orderBy(asc(skillFiles.skill), asc(skillFiles.path)),

    listVersions: async (key) =>
      await db
        .select()
        .from(skillFileVersions)
        .where(
          and(
            eq(skillFileVersions.workspaceId, key.workspaceId),
            eq(skillFileVersions.skill, key.skill),
            eq(skillFileVersions.path, key.path),
          ),
        )
        .orderBy(desc(skillFileVersions.version)),
  };
};
