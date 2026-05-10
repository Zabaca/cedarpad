-- cedarpad outline schema (v2, slice 2)
-- Live migrations are in migrations.ts (versioned via PRAGMA user_version).
-- This file is the canonical reference for the current shape.
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
