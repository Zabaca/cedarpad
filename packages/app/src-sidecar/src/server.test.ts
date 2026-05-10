/**
 * Smoke test: spawn the sidecar, send a ping over NDJSON, expect pong.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.ts')

function pingSidecar(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['run', serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('timeout'))
    }, 5000)
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8')
      const idx = out.indexOf('\n')
      if (idx !== -1) {
        clearTimeout(timer)
        const line = out.slice(0, idx)
        proc.stdin.end()
        try {
          resolve(JSON.parse(line))
        } catch (e) {
          reject(e)
        }
      }
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.stdin.write(JSON.stringify({ id: '1', method: 'ping', params: { msg: 'hi' } }) + '\n')
  })
}

describe('sidecar', () => {
  it('responds to ping with pong', async () => {
    const resp = await pingSidecar()
    expect(resp).toMatchObject({ kind: 'ok', id: '1', result: { pong: true, echo: 'hi' } })
  })
})
