import type { DbClient } from '../db/libsqlClient.ts'

/**
 * Idempotent migrations for a per-workspace outline DB. Embedded as string
 * literals (not a file read) so the sidecar bundle is portable.
 *
 * Versioned via `PRAGMA user_version`:
 *   0 → fresh DB; install v3 schema (kind ∈ content|block|branches).
 *   3 → up to date.
 *
 * v1.1 (ADR-0006) discards prior on-disk shapes (`turn` Nodes, Thread
 * Roots, etc.) — there is no migration code from v1/v2. Existing
 * `.cedarpad/db.sqlite` files must be deleted before launching v1.1.
 * If we encounter a stamped user_version that's not 0 or 3, throw with
 * a helpful message rather than silently doing nothing.
 */

const V3_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('content', 'block', 'branches')),
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  completed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent_pos ON nodes(parent_id, position);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  content,
  content='nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`

async function getUserVersion(db: DbClient): Promise<number> {
  const r = await db.execute('PRAGMA user_version')
  const row = r.rows[0] as Record<string, unknown> | undefined
  if (!row) return 0
  // libSQL returns the column either keyed by name or positionally.
  const v = row.user_version ?? Object.values(row)[0]
  return Number(v ?? 0)
}

async function setUserVersion(db: DbClient, v: number): Promise<void> {
  // PRAGMA does not accept bound parameters, but `v` is an internally-set
  // integer so interpolation is safe.
  await db.execute(`PRAGMA user_version = ${Math.trunc(v)}`)
}

async function nodesTableExists(db: DbClient): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'",
  })
  return r.rows.length > 0
}

export async function runMigrations(db: DbClient): Promise<void> {
  await db.execute('PRAGMA foreign_keys = ON')

  const version = await getUserVersion(db)

  if (version === 3) return

  if (version === 0 && !(await nodesTableExists(db))) {
    // Fresh DB: install Shape B.
    await db.executeMultiple(V3_SCHEMA_SQL)
    await setUserVersion(db, 3)
    return
  }

  // Anything else (v0 with an existing nodes table from slice 1, or v1/v2
  // from prior slices) is a v1 carry-over. We do not migrate; v1.1 is a
  // hard reset. Surface a clear error so the user knows to wipe the DB.
  throw new Error(
    'cedarpad v1.1: legacy outline DB detected. Delete `.cedarpad/db.sqlite` (and any per-workspace DBs under that directory) and relaunch. v1.1 does not migrate v1 data.',
  )
}
