/**
 * Slice 1 e2e (vitest fallback per plan Risk #2).
 *
 * Spawns the bun sidecar, opens a workspace in a worktree-scoped temp repo,
 * creates 3 nested Content Nodes (A → B → C), kills the sidecar, restarts
 * it, and verifies all three nodes survive in the same hierarchy.
 *
 * `tauri-driver` Playwright was deemed too brittle for slice 1; this exercise
 * the full deep-module + sidecar IPC + per-repo libSQL persistence path,
 * which is the substance of the user-visible criterion. The Tauri shell
 * adds a thin invoke→stdin pipe on top — no new persistence behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempWorktreeScoped } from '../../modules/test-utils/worktreeTmp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '../../src-sidecar/src/server.ts')

interface Sidecar {
  proc: ChildProcessWithoutNullStreams
  send: (id: string, method: string, params?: unknown) => Promise<unknown>
  kill: () => Promise<void>
}

function startSidecar(env: NodeJS.ProcessEnv): Sidecar {
  const proc = spawn('bun', ['run', serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env })
  const pending = new Map<string, (resp: { kind: string; result?: unknown; error?: unknown }) => void>()
  let buf = ''
  proc.stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      const parsed = JSON.parse(line) as { id: string; kind: string; result?: unknown; error?: unknown }
      const cb = pending.get(parsed.id)
      if (cb) {
        pending.delete(parsed.id)
        cb(parsed)
      }
    }
  })
  proc.stderr.on('data', () => {
    /* swallow */
  })
  return {
    proc,
    send: (id, method, params) =>
      new Promise((resolve, reject) => {
        pending.set(id, (r) => {
          if (r.kind === 'ok') resolve(r.result)
          else reject(new Error(`sidecar err ${method}: ${JSON.stringify(r.error)}`))
        })
        proc.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n')
      }),
    kill: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve())
        proc.kill()
      }),
  }
}

let tmp: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  tmp = await mkdtempWorktreeScoped('e2e-persistence-')
  env = { ...process.env, CEDARPAD_GLOBAL_DIR: join(tmp, 'global') }
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('e2e persistence', () => {
  it('three nested nodes survive a sidecar restart', async () => {
    const repo = join(tmp, 'repo')
    await mkdir(repo, { recursive: true })

    // First run: create A → B → C nested.
    const s1 = startSidecar(env)
    const ws = (await s1.send('1', 'workspace.open', { repoPath: repo })) as { id: string; repoPath: string }
    const a = (await s1.send('2', 'outline.create', { workspaceId: ws.id, parentId: null, content: 'A' })) as { id: string }
    const b = (await s1.send('3', 'outline.create', { workspaceId: ws.id, parentId: a.id, content: 'B' })) as { id: string }
    const c = (await s1.send('4', 'outline.create', { workspaceId: ws.id, parentId: b.id, content: 'C' })) as { id: string }
    await s1.kill()

    // Second run: re-open same repo, walk the tree.
    const s2 = startSidecar(env)
    // Most-recent should be our repo.
    const recents = (await s2.send('5', 'workspace.recent', {})) as Array<{ id: string; repoPath: string }>
    expect(recents[0]?.repoPath).toBe(repo)
    const ws2 = (await s2.send('6', 'workspace.switch', { id: recents[0]!.id })) as { id: string }

    const roots = (await s2.send('7', 'outline.getChildren', { workspaceId: ws2.id, parentId: null })) as Array<{
      id: string
      content: string
    }>
    expect(roots.map((n) => n.content)).toEqual(['A'])
    expect(roots[0]?.id).toBe(a.id)

    const aChildren = (await s2.send('8', 'outline.getChildren', { workspaceId: ws2.id, parentId: a.id })) as Array<{
      id: string
      content: string
    }>
    expect(aChildren.map((n) => n.content)).toEqual(['B'])
    expect(aChildren[0]?.id).toBe(b.id)

    const bChildren = (await s2.send('9', 'outline.getChildren', { workspaceId: ws2.id, parentId: b.id })) as Array<{
      id: string
      content: string
    }>
    expect(bChildren.map((n) => n.content)).toEqual(['C'])
    expect(bChildren[0]?.id).toBe(c.id)

    await s2.kill()
  }, 30000)
})
