import { randomUUID } from 'node:crypto'
import type { DbClient } from '../db/libsqlClient.ts'
import type { Transaction } from '@libsql/client'
import type { Node, NodeKind, NodeMetadata } from './types.ts'
import { NodeMetadataSchema, NodeSchema } from '../../src/contract.ts'
import { keyBetween } from './ordering.ts'
import { withTransaction } from '../db/txn.ts'

export interface OutlineStore {
  createNode(input: {
    parentId: string | null
    prevSiblingId?: string | null
    content?: string
    kind?: NodeKind
    metadata?: NodeMetadata
  }): Promise<Node>
  getNode(id: string): Promise<Node | null>
  getChildren(parentId: string | null): Promise<Node[]>
  updateNode(input: { id: string; content?: string; completed?: boolean; metadata?: NodeMetadata }): Promise<Node>
  deleteNode(id: string): Promise<{ deleted: number }>
  moveNode(input: { id: string; newParentId: string | null; prevSiblingId?: string | null }): Promise<Node>
  searchNodes(query: string): Promise<Node[]>
}

type Querier = Pick<DbClient, 'execute'> | Transaction

const now = (): number => Date.now()

function rowToNode(row: Record<string, unknown>): Node {
  const metadata = NodeMetadataSchema.parse(JSON.parse(String(row.metadata ?? '{}')))
  return NodeSchema.parse({
    id: String(row.id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: String(row.position),
    kind: String(row.kind),
    content: String(row.content ?? ''),
    metadata,
    completed: Number(row.completed) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  })
}

async function lookupPosition(q: Querier, id: string): Promise<string | null> {
  const r = await q.execute({ sql: 'SELECT position FROM nodes WHERE id = ?', args: [id] })
  return r.rows[0] ? String((r.rows[0] as Record<string, unknown>).position) : null
}

/**
 * Compute the fractional-indexing key for a node about to be inserted at
 * `parentId`, immediately after `prevPos` (or at the start when null).
 * Optionally exclude an `excludeId` (used by moveNode so the node being
 * moved doesn't collide with its current position).
 */
async function computeInsertPosition(
  q: Querier,
  parentId: string | null,
  prevPos: string | null,
  excludeId: string | null = null,
): Promise<string> {
  const conds: string[] = [parentId === null ? 'parent_id IS NULL' : 'parent_id = ?']
  const args: (string | number)[] = []
  if (parentId !== null) args.push(parentId)
  if (prevPos !== null) {
    conds.push('position > ?')
    args.push(prevPos)
  }
  if (excludeId !== null) {
    conds.push('id != ?')
    args.push(excludeId)
  }
  const r = await q.execute({
    sql: `SELECT position FROM nodes WHERE ${conds.join(' AND ')} ORDER BY position LIMIT 1`,
    args,
  })
  const nextPos = r.rows[0] ? String((r.rows[0] as Record<string, unknown>).position) : null
  return keyBetween(prevPos, nextPos)
}

export function createOutlineStore(db: DbClient): OutlineStore {
  const store: OutlineStore = {
    async createNode({ parentId, prevSiblingId = null, content = '', kind = 'content', metadata = {} }) {
      const id = randomUUID()
      const ts = now()
      const prevPos = prevSiblingId ? await lookupPosition(db, prevSiblingId) : null
      const position = await computeInsertPosition(db, parentId, prevPos)
      await db.execute({
        sql: `INSERT INTO nodes (id, parent_id, position, kind, content, metadata, completed, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        args: [id, parentId, position, kind, content, JSON.stringify(metadata), ts, ts],
      })
      return {
        id,
        parentId,
        position,
        kind,
        content,
        metadata,
        completed: false,
        createdAt: ts,
        updatedAt: ts,
      }
    },

    async getNode(id) {
      const r = await db.execute({ sql: 'SELECT * FROM nodes WHERE id = ?', args: [id] })
      if (!r.rows[0]) return null
      return rowToNode(r.rows[0] as Record<string, unknown>)
    },

    async getChildren(parentId) {
      const r =
        parentId === null
          ? await db.execute({ sql: 'SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY position' })
          : await db.execute({
              sql: 'SELECT * FROM nodes WHERE parent_id = ? ORDER BY position',
              args: [parentId],
            })
      return r.rows.map((row) => rowToNode(row as Record<string, unknown>))
    },

    async updateNode({ id, content, completed, metadata }) {
      const sets: string[] = []
      const args: (string | number)[] = []
      if (content !== undefined) {
        sets.push('content = ?')
        args.push(content)
      }
      if (completed !== undefined) {
        sets.push('completed = ?')
        args.push(completed ? 1 : 0)
      }
      if (metadata !== undefined) {
        sets.push('metadata = ?')
        args.push(JSON.stringify(metadata))
      }
      sets.push('updated_at = ?')
      args.push(now())
      args.push(id)
      await db.execute({ sql: `UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`, args })
      const fetched = await store.getNode(id)
      if (!fetched) throw new Error(`node ${id} not found`)
      return fetched
    },

    async deleteNode(id) {
      const out = await db.execute({ sql: 'DELETE FROM nodes WHERE id = ?', args: [id] })
      return { deleted: Number(out.rowsAffected ?? 0) }
    },

    async moveNode({ id, newParentId, prevSiblingId = null }) {
      if (newParentId === id) throw new Error('cannot move a node under itself')
      // Cycle check: walk newParentId's ancestors; id must not appear.
      if (newParentId !== null) {
        let cursor: string | null = newParentId
        const visited = new Set<string>()
        while (cursor !== null) {
          if (cursor === id) throw new Error('cannot move a node under its own descendant')
          if (visited.has(cursor)) break
          visited.add(cursor)
          const r = await db.execute({ sql: 'SELECT parent_id FROM nodes WHERE id = ?', args: [cursor] })
          const row = r.rows[0] as Record<string, unknown> | undefined
          if (!row) break
          cursor = row.parent_id == null ? null : String(row.parent_id)
        }
      }

      return withTransaction(db, async (tx) => {
        const prevPos = prevSiblingId ? await lookupPosition(tx, prevSiblingId) : null
        const position = await computeInsertPosition(tx, newParentId, prevPos, id)
        await tx.execute({
          sql: 'UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?',
          args: [newParentId, position, now(), id],
        })
        const r = await tx.execute({ sql: 'SELECT * FROM nodes WHERE id = ?', args: [id] })
        if (!r.rows[0]) throw new Error(`node ${id} disappeared during move`)
        return rowToNode(r.rows[0] as Record<string, unknown>)
      })
    },

    async searchNodes(query) {
      const r = await db.execute({
        sql: `SELECT nodes.* FROM nodes_fts
              JOIN nodes ON nodes.rowid = nodes_fts.rowid
              WHERE nodes_fts MATCH ?
              ORDER BY rank`,
        args: [query],
      })
      return r.rows.map((row) => rowToNode(row as Record<string, unknown>))
    },
  }
  return store
}
