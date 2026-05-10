import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient, type DbClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { workspaceDbPath, workspaceDbDir, repoGitignorePath } from './paths.ts'
import {
  openRecentsDb,
  upsertRecent,
  listRecent,
  trimRecent,
  findById,
  findByRepoPath,
  setActiveNodeId,
  type RecentRow,
} from './recentsStore.ts'
import type { WorkspaceSummary } from '../../src/contract.ts'

export interface WorkspaceManager {
  open(repoPath: string): Promise<WorkspaceSummary>
  switch(id: string): Promise<WorkspaceSummary>
  recent(): Promise<WorkspaceSummary[]>
  active(): Promise<WorkspaceSummary | null>
  /** Persist the zoomed-in Node id for a workspace. `null` clears the zoom. */
  setActiveNode(id: string, activeNodeId: string | null): Promise<WorkspaceSummary>
  /** Returns the libSQL outline DB client for a workspace, opening on demand. */
  outlineDb(id: string): Promise<DbClient>
}

export interface WorkspaceManagerOpts {
  recentsDbUrl: string
  recentLimit?: number
}

const GITIGNORE_LINE = '.cedarpad/'

async function ensureGitignore(repoPath: string): Promise<void> {
  const path = repoGitignorePath(repoPath)
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch {
    /* no .gitignore yet */
  }
  const lines = content.split(/\r?\n/)
  if (!lines.some((l) => l.trim() === GITIGNORE_LINE)) {
    const updated = (content.length === 0 || content.endsWith('\n') ? content : content + '\n') + GITIGNORE_LINE + '\n'
    await writeFile(path, updated, 'utf8')
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function rowToSummary(row: RecentRow): WorkspaceSummary {
  return {
    id: row.id,
    repoPath: row.repoPath,
    displayName: row.displayName,
    dbPath: row.dbPath,
    lastOpenedAt: row.lastOpenedAt,
    activeNodeId: row.activeNodeId,
  }
}

export function createWorkspaceManager(opts: WorkspaceManagerOpts): WorkspaceManager {
  const limit = opts.recentLimit ?? 10
  let recentsDb: DbClient | null = null
  let activeId: string | null = null
  const outlineClients = new Map<string, DbClient>()

  async function getRecentsDb(): Promise<DbClient> {
    if (!recentsDb) recentsDb = await openRecentsDb(opts.recentsDbUrl)
    return recentsDb
  }

  return {
    async open(repoPath) {
      if (!(await fileExists(repoPath))) {
        throw new Error(`repo path does not exist: ${repoPath}`)
      }
      const dbDir = workspaceDbDir(repoPath)
      await mkdir(dbDir, { recursive: true })
      const dbPath = workspaceDbPath(repoPath)
      const outlineDb = createClient({ url: `file:${dbPath}` })
      await runMigrations(outlineDb)
      await ensureGitignore(repoPath)

      const recents = await getRecentsDb()
      const existing = await findByRepoPath(recents, repoPath)
      const id = existing?.id ?? randomUUID()
      const ts = Date.now()
      const row: RecentRow = {
        id,
        repoPath,
        displayName: basename(repoPath),
        dbPath,
        lastOpenedAt: ts,
        // Preserve any persisted zoom across re-opens; new repos default to root.
        activeNodeId: existing?.activeNodeId ?? null,
      }
      await upsertRecent(recents, row)
      await trimRecent(recents, limit)

      activeId = id
      outlineClients.set(id, outlineDb)
      return rowToSummary(row)
    },

    async switch(id) {
      const recents = await getRecentsDb()
      const found = await findById(recents, id)
      if (!found) throw new Error(`unknown workspace id: ${id}`)
      activeId = id
      // Bump last_opened_at so the newly-active workspace floats up
      await upsertRecent(recents, { ...found, lastOpenedAt: Date.now() })
      await trimRecent(recents, limit)
      const updated = await findById(recents, id)
      return rowToSummary(updated!)
    },

    async recent() {
      const db = await getRecentsDb()
      const rows = await listRecent(db, limit)
      return rows.map(rowToSummary)
    },

    async active() {
      if (!activeId) return null
      const db = await getRecentsDb()
      const row = await findById(db, activeId)
      return row ? rowToSummary(row) : null
    },

    async setActiveNode(id, activeNodeId) {
      const db = await getRecentsDb()
      const found = await findById(db, id)
      if (!found) throw new Error(`unknown workspace id: ${id}`)
      await setActiveNodeId(db, id, activeNodeId)
      const updated = await findById(db, id)
      return rowToSummary(updated!)
    },

    async outlineDb(id) {
      const cached = outlineClients.get(id)
      if (cached) return cached
      const db = await getRecentsDb()
      const row = await findById(db, id)
      if (!row) throw new Error(`unknown workspace id: ${id}`)
      const client = createClient({ url: `file:${row.dbPath}` })
      await runMigrations(client)
      outlineClients.set(id, client)
      return client
    },
  }
}
