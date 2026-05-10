import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient, type DbClient } from '../db/libsqlClient.ts'
import { runMigrations } from './migrations.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempWorktreeScoped('outline-migrations-')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function userVersion(db: DbClient): Promise<number> {
  const r = await db.execute('PRAGMA user_version')
  const row = r.rows[0] as Record<string, unknown> | undefined
  if (!row) return 0
  const v = row.user_version ?? Object.values(row)[0]
  return Number(v ?? 0)
}

/**
 * Reproduce the slice 1 schema verbatim — same CHECK constraint, no
 * user_version stamp — so we can verify the v1→v2 upgrade path on a
 * realistic legacy DB.
 */
const V1_SCHEMA_SQL = `
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

describe('outline migrations', () => {
  it('fresh DB lands at user_version=2 with the v2 CHECK', async () => {
    const db = createClient({ url: `file:${join(tmpDir, 'fresh.db')}` })
    await runMigrations(db)
    expect(await userVersion(db)).toBe(2)

    // Inserting kind='turn' must succeed (would have failed on v1).
    await db.execute({
      sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
            VALUES (?, NULL, ?, 'turn', '', '{}', 0, ?, ?)`,
      args: ['t1', 'a0', Date.now(), Date.now()],
    })
    const r = await db.execute({ sql: 'SELECT kind FROM nodes WHERE id = ?', args: ['t1'] })
    expect(String((r.rows[0] as Record<string, unknown>).kind)).toBe('turn')
  })

  it('upgrades a v1 DB (slice-1-shaped) to v2 and preserves rows', async () => {
    const dbUrl = `file:${join(tmpDir, 'legacy.db')}`
    const db = createClient({ url: dbUrl })

    // Seed a v1-shaped DB exactly the way slice 1 wrote it.
    await db.executeMultiple(V1_SCHEMA_SQL)
    await db.execute({
      sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
            VALUES (?, NULL, ?, 'content', ?, '{}', 0, ?, ?)`,
      args: ['n1', 'a0', 'hello', 1000, 1000],
    })

    // Slice 1 never set user_version — it should still read as 0.
    expect(await userVersion(db)).toBe(0)

    await runMigrations(db)
    expect(await userVersion(db)).toBe(2)

    // Original row preserved.
    const r = await db.execute({ sql: 'SELECT id, content, kind FROM nodes WHERE id = ?', args: ['n1'] })
    expect(r.rows[0]).toBeDefined()
    expect(String((r.rows[0] as Record<string, unknown>).content)).toBe('hello')

    // New kinds now allowed.
    await db.execute({
      sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
            VALUES (?, NULL, ?, 'block', 'b', '{}', 0, ?, ?)`,
      args: ['b1', 'a1', Date.now(), Date.now()],
    })
    const after = await db.execute('SELECT COUNT(*) as c FROM nodes')
    expect(Number((after.rows[0] as Record<string, unknown>).c)).toBe(2)

    // FTS still works post-upgrade.
    const fts = await db.execute({
      sql: `SELECT nodes.id FROM nodes_fts JOIN nodes ON nodes.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ?`,
      args: ['hello'],
    })
    expect(fts.rows.map((r) => String((r as Record<string, unknown>).id))).toContain('n1')
  })

  it('is idempotent — re-running on a v2 DB is a no-op', async () => {
    const db = createClient({ url: `file:${join(tmpDir, 'twice.db')}` })
    await runMigrations(db)
    await runMigrations(db)
    await runMigrations(db)
    expect(await userVersion(db)).toBe(2)
  })
})
