import type { DbClient } from './libsqlClient.ts'
import type { Transaction } from '@libsql/client'

/**
 * Run `fn` inside an immediate transaction. libSQL's transaction object has
 * the same query interface as the client. Rolls back on any throw.
 */
export async function withTransaction<T>(db: DbClient, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction('write')
  try {
    const out = await fn(tx)
    await tx.commit()
    return out
  } catch (e) {
    await tx.rollback().catch(() => {})
    throw e
  }
}
