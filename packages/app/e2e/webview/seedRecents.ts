/**
 * Seeds the recents store by spawning the bun sidecar once and calling
 * `workspace.open` against a fresh temp repo. The Tauri binary, when
 * launched with the same `CEDARPAD_GLOBAL_DIR`, will see the repo as
 * most-recent and auto-restore it on boot — exactly the same code path
 * users hit when they reopen the app.
 *
 * No bypass of `contract.ts` here: this calls the same NDJSON RPC over
 * stdio that the renderer uses; the only difference is the spawner.
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarServer = join(here, '../../src-sidecar/src/server.ts')

export interface SeedResult {
  /** The repo path that was opened. */
  repoPath: string
  /** The CEDARPAD_GLOBAL_DIR env value used. Pass to the binary launch. */
  globalDir: string
}

export async function seedRecentRepo(opts: {
  baseTmp: string
  repoSubdir?: string
  globalSubdir?: string
}): Promise<SeedResult> {
  const repoPath = join(opts.baseTmp, opts.repoSubdir ?? 'repo')
  const globalDir = join(opts.baseTmp, opts.globalSubdir ?? 'global')
  await mkdir(repoPath, { recursive: true })
  await mkdir(globalDir, { recursive: true })

  const proc = spawn('bun', ['run', sidecarServer], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CEDARPAD_GLOBAL_DIR: globalDir },
  })

  const done = new Promise<void>((resolve, reject) => {
    let buf = ''
    const onData = (b: Buffer) => {
      buf += b.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { id: string; kind: string; error?: unknown }
          if (msg.id === 'seed') {
            if (msg.kind === 'ok') resolve()
            else reject(new Error(`seed failed: ${JSON.stringify(msg.error)}`))
          }
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
    }
    proc.stdout.on('data', onData)
    proc.on('exit', (code) => reject(new Error(`sidecar exited before seed (code ${code})`)))
  })

  proc.stdin.write(JSON.stringify({ id: 'seed', method: 'workspace.open', params: { repoPath } }) + '\n')
  try {
    await done
  } finally {
    proc.kill()
    await new Promise<void>((r) => proc.once('exit', () => r()))
  }
  return { repoPath, globalDir }
}
