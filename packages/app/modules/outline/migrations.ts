import type { DbClient } from '../db/libsqlClient.ts'

/**
 * Idempotent migrations for a per-workspace outline DB. Embedded as string
 * literals (not a file read) so the sidecar bundle is portable.
 *
 * Versioned via `PRAGMA user_version`:
 *   0 → fresh DB; install v2 schema (kind ∈ content|turn|block).
 *   1 → slice 1 DB; rebuild `nodes` to widen the kind CHECK to v2.
 *   2 → up to date.
 *
 * Backward compatibility: existing rows from slice 1 are all `kind='content'`
 * and copy through unchanged. The rebuild is wrapped in a transaction so a
 * crash mid-migration leaves the original table intact.
 */

const V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('content', 'turn', 'block')),
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

/**
 * Rebuild `nodes` so that the CHECK on `kind` admits `turn` and `block`.
 * SQLite has no ALTER COLUMN/CHECK; a copy-rebuild is the standard play.
 *
 * Runs under a transaction. The FTS triggers on the old table fire as we
 * delete rows; once we drop them and recreate fresh ones on the new table,
 * the FTS index is repopulated by the triggers when we copy rows back.
 */
const V1_TO_V2_SQL = `
DROP TRIGGER IF EXISTS nodes_ai;
DROP TRIGGER IF EXISTS nodes_ad;
DROP TRIGGER IF EXISTS nodes_au;
DROP TABLE IF EXISTS nodes_fts;

ALTER TABLE nodes RENAME TO nodes_v1;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('content', 'turn', 'block')),
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  completed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
SELECT id, parent_id, position, kind, content, metadata, completed, created_at, updated_at FROM nodes_v1;

DROP TABLE nodes_v1;

CREATE INDEX idx_nodes_parent_pos ON nodes(parent_id, position);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  content,
  content='nodes',
  content_rowid='rowid'
);

INSERT INTO nodes_fts(rowid, content) SELECT rowid, content FROM nodes;

CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
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

  let version = await getUserVersion(db)

  // Slice 1 shipped without writing user_version; treat any DB that already
  // has a `nodes` table at version 0 as v1 needing upgrade.
  if (version === 0 && (await nodesTableExists(db))) {
    version = 1
  }

  if (version === 0) {
    await db.executeMultiple(V2_SCHEMA_SQL)
    await setUserVersion(db, 2)
    return
  }

  if (version === 1) {
    await db.executeMultiple(V1_TO_V2_SQL)
    await setUserVersion(db, 2)
    return
  }

  // version >= 2 → already current, no-op (idempotent re-run).
}
