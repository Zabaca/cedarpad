import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Worktree-scoped temp directory helper.
 *
 * Reads `CEDARPAD_TMP` from env (set by the per-worktree wrapper) so two
 * worktrees of the same repo never collide on `/tmp/cedarpad-*` fixtures.
 * Falls back to `os.tmpdir()` + a random UUID for plain runs outside a
 * worktree wrapper.
 *
 * See ADR-0003 and CLAUDE.md §6.
 */
export async function mkdtempWorktreeScoped(prefix = 'cedarpad-'): Promise<string> {
  const base = process.env.CEDARPAD_TMP ?? join(tmpdir(), `cedarpad-${randomUUID()}`)
  // mkdtemp requires the parent to exist
  const { mkdir } = await import('node:fs/promises')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, prefix))
}

export async function rmrf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
