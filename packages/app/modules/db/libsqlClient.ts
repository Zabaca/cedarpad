import { createClient as createLibsqlClient, type Client } from '@libsql/client'

/**
 * Thin wrapper so callers don't import @libsql/client directly. Lets us
 * swap to the embedded-replicas variant in v2 without touching callers.
 */
export type DbClient = Client

export function createClient(opts: { url: string }): DbClient {
  return createLibsqlClient({ url: opts.url })
}
