import { createClient, type DbClient } from '../db/libsqlClient.ts'

const RECENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS recent_workspaces (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  db_path TEXT NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recent_last_opened ON recent_workspaces(last_opened_at DESC);
`

export interface RecentRow {
  id: string
  repoPath: string
  displayName: string
  dbPath: string
  lastOpenedAt: number
  /** ID of the Node currently zoomed into; null = workspace root. */
  activeNodeId: string | null
}

/**
 * Idempotent column add for slice 7. SQLite has no IF NOT EXISTS for
 * ALTER TABLE ADD COLUMN, so we sniff PRAGMA table_info first.
 */
async function ensureActiveNodeIdColumn(db: DbClient): Promise<void> {
  const r = await db.execute({ sql: 'PRAGMA table_info(recent_workspaces)', args: [] })
  const has = r.rows.some((row) => String((row as Record<string, unknown>).name) === 'active_node_id')
  if (!has) {
    await db.execute({
      sql: 'ALTER TABLE recent_workspaces ADD COLUMN active_node_id TEXT',
      args: [],
    })
  }
}

export async function openRecentsDb(url: string): Promise<DbClient> {
  const db = createClient({ url })
  await db.executeMultiple(RECENTS_SCHEMA)
  await ensureActiveNodeIdColumn(db)
  return db
}

export async function upsertRecent(db: DbClient, row: RecentRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO recent_workspaces (id, repo_path, display_name, db_path, last_opened_at, active_node_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_path) DO UPDATE SET
            display_name = excluded.display_name,
            db_path = excluded.db_path,
            last_opened_at = excluded.last_opened_at,
            active_node_id = excluded.active_node_id`,
    args: [row.id, row.repoPath, row.displayName, row.dbPath, row.lastOpenedAt, row.activeNodeId],
  })
}

/**
 * Update only the zoom pointer for a workspace; leaves the rest untouched.
 * `null` clears the zoom (root view).
 */
export async function setActiveNodeId(
  db: DbClient,
  id: string,
  activeNodeId: string | null,
): Promise<void> {
  await db.execute({
    sql: 'UPDATE recent_workspaces SET active_node_id = ? WHERE id = ?',
    args: [activeNodeId, id],
  })
}

export async function listRecent(db: DbClient, limit: number): Promise<RecentRow[]> {
  const r = await db.execute({
    sql: 'SELECT * FROM recent_workspaces ORDER BY last_opened_at DESC LIMIT ?',
    args: [limit],
  })
  return r.rows.map((raw) => rawRowToRecent(raw as Record<string, unknown>))
}

function rawRowToRecent(row: Record<string, unknown>): RecentRow {
  return {
    id: String(row.id),
    repoPath: String(row.repo_path),
    displayName: String(row.display_name),
    dbPath: String(row.db_path),
    lastOpenedAt: Number(row.last_opened_at),
    activeNodeId: row.active_node_id == null ? null : String(row.active_node_id),
  }
}

/**
 * Trim recents to the most recent `limit` entries, deleting the rest.
 */
export async function trimRecent(db: DbClient, limit: number): Promise<void> {
  await db.execute({
    sql: `DELETE FROM recent_workspaces
          WHERE id NOT IN (
            SELECT id FROM recent_workspaces ORDER BY last_opened_at DESC LIMIT ?
          )`,
    args: [limit],
  })
}

export async function findById(db: DbClient, id: string): Promise<RecentRow | null> {
  const r = await db.execute({ sql: 'SELECT * FROM recent_workspaces WHERE id = ?', args: [id] })
  if (!r.rows[0]) return null
  return rawRowToRecent(r.rows[0] as Record<string, unknown>)
}

export async function findByRepoPath(db: DbClient, repoPath: string): Promise<RecentRow | null> {
  const r = await db.execute({ sql: 'SELECT * FROM recent_workspaces WHERE repo_path = ?', args: [repoPath] })
  if (!r.rows[0]) return null
  return rawRowToRecent(r.rows[0] as Record<string, unknown>)
}
