import type { DbClient } from '../db/libsqlClient.ts'

/**
 * Idempotent migrations for a per-workspace outline DB. Embedded as a string
 * literal (not a file read) so the sidecar bundle is portable.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('content')),
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

export async function runMigrations(db: DbClient): Promise<void> {
  // libSQL accepts multi-statement scripts via `executeMultiple`.
  await db.executeMultiple(SCHEMA_SQL)
  // Ensure foreign-key cascades fire for ON DELETE CASCADE
  await db.execute('PRAGMA foreign_keys = ON')
}
