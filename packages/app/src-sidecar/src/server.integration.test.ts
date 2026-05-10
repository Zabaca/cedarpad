/**
 * Integration smoke: spawn the sidecar with a worktree-scoped CEDARPAD_GLOBAL_DIR,
 * open a workspace, create a node, fetch it back. Exercises the full FE→BE
 * contract path (request validation + response validation) and the deep
 * module wiring inside the sidecar.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempWorktreeScoped } from '../../modules/test-utils/worktreeTmp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.ts')

interface Sidecar {
  proc: ChildProcessWithoutNullStreams
  send: (req: { id: string; method: string; params?: unknown }) => Promise<unknown>
  kill: () => void
}

// (extended below with streaming support)

interface SidecarStream extends Sidecar {
  /** Drive a streaming method; resolves with all stream events + the final result. */
  sendStream: (
    req: { id: string; method: string; params?: unknown },
    onEvent?: (event: unknown) => void,
  ) => Promise<{ events: unknown[]; result: unknown }>
}

function startSidecar(env: NodeJS.ProcessEnv): SidecarStream {
  const proc = spawn('bun', ['run', serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env })
  const pending = new Map<string, (resp: { kind: string; result?: unknown; error?: unknown }) => void>()
  const streamCollectors = new Map<
    string,
    {
      events: unknown[]
      onEvent?: (event: unknown) => void
    }
  >()
  let buf = ''
  proc.stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      const parsed = JSON.parse(line) as {
        id: string
        kind: string
        result?: unknown
        error?: unknown
        event?: unknown
      }
      if (parsed.kind === 'stream') {
        const c = streamCollectors.get(parsed.id)
        if (c) {
          c.events.push(parsed.event)
          c.onEvent?.(parsed.event)
        }
        continue
      }
      const cb = pending.get(parsed.id)
      if (cb) {
        pending.delete(parsed.id)
        cb(parsed)
      }
    }
  })
  proc.stderr.on('data', () => {
    /* swallow log noise */
  })
  return {
    proc,
    send: (req) =>
      new Promise((resolve, reject) => {
        const id = req.id
        pending.set(id, (resp) => {
          if (resp.kind === 'ok') resolve(resp.result)
          else reject(new Error(`sidecar err: ${JSON.stringify(resp.error)}`))
        })
        proc.stdin.write(JSON.stringify({ id, method: req.method, params: req.params ?? {} }) + '\n')
      }),
    sendStream: (req, onEvent) =>
      new Promise((resolve, reject) => {
        const id = req.id
        const collector = { events: [] as unknown[], onEvent }
        streamCollectors.set(id, collector)
        pending.set(id, (resp) => {
          streamCollectors.delete(id)
          if (resp.kind === 'ok') resolve({ events: collector.events, result: resp.result })
          else reject(new Error(`sidecar err: ${JSON.stringify(resp.error)}`))
        })
        proc.stdin.write(JSON.stringify({ id, method: req.method, params: req.params ?? {} }) + '\n')
      }),
    kill: () => {
      proc.kill()
    },
  }
}

let tmp: string
let sidecar: SidecarStream

beforeEach(async () => {
  tmp = await mkdtempWorktreeScoped('sidecar-int-')
  sidecar = startSidecar({
    ...process.env,
    CEDARPAD_GLOBAL_DIR: join(tmp, 'global'),
  })
})

afterEach(async () => {
  sidecar.kill()
  await rm(tmp, { recursive: true, force: true })
})

describe('sidecar integration', () => {
  it('round-trips workspace.open + outline.create + outline.getChildren', async () => {
    const repo = join(tmp, 'repo')
    await mkdir(repo, { recursive: true })

    const ws = (await sidecar.send({ id: '1', method: 'workspace.open', params: { repoPath: repo } })) as {
      id: string
      repoPath: string
    }
    expect(ws.repoPath).toBe(repo)

    const node = (await sidecar.send({
      id: '2',
      method: 'outline.create',
      params: { workspaceId: ws.id, parentId: null, content: 'hello' },
    })) as { id: string; content: string }
    expect(node.content).toBe('hello')

    const roots = (await sidecar.send({
      id: '3',
      method: 'outline.getChildren',
      params: { workspaceId: ws.id, parentId: null },
    })) as Array<{ id: string }>
    expect(roots.map((n) => n.id)).toContain(node.id)
  }, 15000)

  it('drives sdk.sendPrompt → streaming Block Nodes under the Prompt (Shape B, fake SDK)', async () => {
    // Spawn a fresh sidecar with the fake-SDK env flag flipped on so we
    // never touch the real Claude Agent SDK.
    sidecar.kill()
    sidecar = startSidecar({
      ...process.env,
      CEDARPAD_GLOBAL_DIR: join(tmp, 'global'),
      CEDARPAD_E2E_FAKE_SDK: '1',
    })

    const repo = join(tmp, 'repo')
    await mkdir(repo, { recursive: true })

    const ws = (await sidecar.send({
      id: '1',
      method: 'workspace.open',
      params: { repoPath: repo },
    })) as {
      id: string
    }

    // Set up a Shape B tree: a session-bearer Content Node with a
    // Prompt child. The Prompt is the target of sdk.sendPrompt; its
    // bearer parent gets the captured sdkSessionId.
    const bearer = (await sidecar.send({
      id: '2',
      method: 'outline.create',
      params: {
        workspaceId: ws.id,
        parentId: null,
        content: 'idea',
        metadata: { sdkSessionId: null },
      },
    })) as { id: string }

    const prompt = (await sidecar.send({
      id: '3',
      method: 'outline.create',
      params: {
        workspaceId: ws.id,
        parentId: bearer.id,
        content: 'what is this repo?',
        metadata: { state: 'streaming' },
      },
    })) as { id: string }

    // Push an API key into the sidecar (Rust would normally do this on
    // boot via the inject path).
    await sidecar.send({
      id: '4',
      method: 'auth.injectApiKey',
      params: { key: 'sk-ant-fake' },
    })

    const result = (await sidecar.sendStream({
      id: '5',
      method: 'sdk.sendPrompt',
      params: {
        workspaceId: ws.id,
        promptNodeId: prompt.id,
        prompt: 'what is this repo?',
        repoPath: repo,
      },
    })) as { events: unknown[]; result: { promptId: string; reason: string } }

    expect(result.result.reason).toBe('done')
    expect(result.result.promptId).toBe(prompt.id)

    // The fake script emits 4 block-completes (text, tool_use, tool_result, text).
    const completes = result.events.filter(
      (e) => (e as { kind?: string }).kind === 'block-complete',
    )
    expect(completes).toHaveLength(4)

    // The prompt-complete event also fires.
    const promptComplete = result.events.find(
      (e) => (e as { kind?: string }).kind === 'prompt-complete',
    )
    expect(promptComplete).toBeTruthy()

    // Block Nodes were persisted as children of the Prompt directly —
    // no Turn Node intermediate.
    const blocks = (await sidecar.send({
      id: '6',
      method: 'outline.getChildren',
      params: { workspaceId: ws.id, parentId: prompt.id },
    })) as Array<{ id: string; kind: string }>
    expect(blocks).toHaveLength(4)
    for (const b of blocks) {
      expect(b.kind).toBe('block')
    }
  }, 30000)
})
