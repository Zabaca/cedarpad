import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import { createWorkspaceManager, type WorkspaceManager } from './workspaceManager.ts'

let tmp: string
let wm: WorkspaceManager

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  tmp = await mkdtempWorktreeScoped('workspace-mgr-')
  wm = createWorkspaceManager({ recentsDbUrl: `file:${join(tmp, 'global.db')}`, recentLimit: 10 })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function makeRepo(name: string): Promise<string> {
  const repo = join(tmp, name)
  await mkdir(repo, { recursive: true })
  return repo
}

describe('workspaceManager', () => {
  it('opening a workspace creates a per-repo libSQL DB and runs migrations', async () => {
    const repo = await makeRepo('fake-repo')
    const ws = await wm.open(repo)
    expect(ws.dbPath).toMatch(/\.cedarpad\/db\.sqlite$/)
    expect(await fileExists(ws.dbPath)).toBe(true)
  })

  it('recent() returns the just-opened workspace first', async () => {
    const a = await makeRepo('a')
    const b = await makeRepo('b')
    await wm.open(a)
    await wm.open(b)
    const recent = await wm.recent()
    expect(recent[0]?.repoPath).toBe(b)
    expect(recent[1]?.repoPath).toBe(a)
  })

  it('switch(id) swaps the active workspace', async () => {
    const a = await makeRepo('a')
    const b = await makeRepo('b')
    const wsA = await wm.open(a)
    const wsB = await wm.open(b)
    expect((await wm.active())?.id).toBe(wsB.id)
    await wm.switch(wsA.id)
    expect((await wm.active())?.id).toBe(wsA.id)
  })

  it('recent() is capped to N (10), oldest evicted', async () => {
    for (let i = 0; i < 12; i++) {
      const r = await makeRepo(`r${i}`)
      await wm.open(r)
    }
    const recent = await wm.recent()
    expect(recent.length).toBe(10)
    // Oldest two (r0, r1) should be gone; r11 is most recent
    expect(recent[0]?.repoPath.endsWith('/r11')).toBe(true)
    expect(recent.find((w) => w.repoPath.endsWith('/r0'))).toBeUndefined()
    expect(recent.find((w) => w.repoPath.endsWith('/r1'))).toBeUndefined()
  })

  it('open appends .cedarpad/ to .gitignore when missing', async () => {
    const repo = await makeRepo('with-gitignore')
    await writeFile(join(repo, '.gitignore'), 'node_modules\n', 'utf8')
    await wm.open(repo)
    const gi = await readFile(join(repo, '.gitignore'), 'utf8')
    expect(gi).toContain('.cedarpad/')
  })

  it('open creates .gitignore if absent, with .cedarpad/ inside', async () => {
    const repo = await makeRepo('no-gitignore')
    await wm.open(repo)
    const gi = await readFile(join(repo, '.gitignore'), 'utf8')
    expect(gi).toContain('.cedarpad/')
  })

  it('open is idempotent: re-opening the same repo does not duplicate it in recents', async () => {
    const repo = await makeRepo('rep')
    await wm.open(repo)
    await wm.open(repo)
    const recent = await wm.recent()
    expect(recent.filter((w) => w.repoPath === repo).length).toBe(1)
  })
})
