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
 * Reproduce the v1 (slice 1) schema verbatim — same CHECK constraint,
 * no user_version stamp — so we can verify v1.1 refuses to migrate
 * legacy DBs (per ADR-0006: v1.1 is a hard reset, no migration code).
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
`

describe('outline migrations (v1.1 Shape B)', () => {
  it('fresh DB lands at user_version=3 with the Shape B CHECK', async () => {
    const db = createClient({ url: `file:${join(tmpDir, 'fresh.db')}` })
    await runMigrations(db)
    expect(await userVersion(db)).toBe(3)

    // kind='block' must succeed.
    await db.execute({
      sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
            VALUES (?, NULL, ?, 'block', '', '{}', 0, ?, ?)`,
      args: ['b1', 'a0', Date.now(), Date.now()],
    })
    // kind='branches' must succeed.
    await db.execute({
      sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
            VALUES (?, NULL, ?, 'branches', '', '{}', 0, ?, ?)`,
      args: ['br1', 'a1', Date.now(), Date.now()],
    })
    // kind='turn' must NOT succeed (CHECK constraint).
    await expect(
      db.execute({
        sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
              VALUES (?, NULL, ?, 'turn', '', '{}', 0, ?, ?)`,
        args: ['t1', 'a2', Date.now(), Date.now()],
      }),
    ).rejects.toThrow(/CHECK/i)
  })

  it('refuses to migrate a v1 DB and throws with a wipe hint', async () => {
    const dbUrl = `file:${join(tmpDir, 'legacy.db')}`
    const db = createClient({ url: dbUrl })

    await db.executeMultiple(V1_SCHEMA_SQL)
    await db.execute({
      sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
            VALUES (?, NULL, ?, 'content', ?, '{}', 0, ?, ?)`,
      args: ['n1', 'a0', 'hello', 1000, 1000],
    })
    expect(await userVersion(db)).toBe(0)

    await expect(runMigrations(db)).rejects.toThrow(/Delete `\.cedarpad\/db\.sqlite`/)
  })

  it('is idempotent — re-running on a v3 DB is a no-op', async () => {
    const db = createClient({ url: `file:${join(tmpDir, 'twice.db')}` })
    await runMigrations(db)
    await runMigrations(db)
    await runMigrations(db)
    expect(await userVersion(db)).toBe(3)
  })
})
