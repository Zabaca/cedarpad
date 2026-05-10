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

  it('drives thread.start + thread.appendPrompt + thread.appendTurn over IPC', async () => {
    const repo = join(tmp, 'repo')
    await mkdir(repo, { recursive: true })

    const ws = (await sidecar.send({ id: '1', method: 'workspace.open', params: { repoPath: repo } })) as {
      id: string
    }

    const root = (await sidecar.send({
      id: '2',
      method: 'outline.create',
      params: { workspaceId: ws.id, parentId: null, content: 'idea' },
    })) as { id: string }

    const promoted = (await sidecar.send({
      id: '3',
      method: 'thread.start',
      params: { workspaceId: ws.id, rootNodeId: root.id },
    })) as { id: string; metadata: Record<string, unknown> }
    expect(promoted.metadata.isThreadRoot).toBe(true)

    const prompt = (await sidecar.send({
      id: '4',
      method: 'thread.appendPrompt',
      params: { workspaceId: ws.id, threadRootId: root.id, content: 'how does X work?' },
    })) as { id: string; parentId: string; kind: string; content: string }
    expect(prompt.parentId).toBe(root.id)
    expect(prompt.kind).toBe('content')
    expect(prompt.content).toBe('how does X work?')

    const turn = (await sidecar.send({
      id: '5',
      method: 'thread.appendTurn',
      params: {
        workspaceId: ws.id,
        threadRootId: root.id,
        blocks: [
          { kind: 'text', text: 'Looking…' },
          { kind: 'tool_use', toolName: 'Read', toolUseId: 't1', input: { path: 'a.md' } },
          { kind: 'tool_result', toolUseId: 't1', output: 'ok' },
        ],
      },
    })) as { turn: { id: string; kind: string }; blocks: Array<{ id: string; kind: string; parentId: string }> }
    expect(turn.turn.kind).toBe('turn')
    expect(turn.blocks).toHaveLength(3)
    for (const b of turn.blocks) {
      expect(b.kind).toBe('block')
      expect(b.parentId).toBe(turn.turn.id)
    }
  }, 15000)

  it('drives sdk.sendPrompt → streaming Block Nodes (e2e fake SDK)', async () => {
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

    const ws = (await sidecar.send({ id: '1', method: 'workspace.open', params: { repoPath: repo } })) as {
      id: string
    }
    const root = (await sidecar.send({
      id: '2',
      method: 'outline.create',
      params: { workspaceId: ws.id, parentId: null, content: 'idea' },
    })) as { id: string }
    await sidecar.send({
      id: '3',
      method: 'thread.start',
      params: { workspaceId: ws.id, rootNodeId: root.id },
    })

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
        threadRootId: root.id,
        prompt: 'what is this repo?',
        repoPath: repo,
      },
    })) as { events: unknown[]; result: { turnId: string; reason: string } }

    expect(result.result.reason).toBe('done')
    expect(result.result.turnId).toBeTruthy()

    // The fake script emits 4 block-completes (text, tool_use, tool_result, text).
    const completes = result.events.filter(
      (e) => (e as { kind?: string }).kind === 'block-complete',
    )
    expect(completes).toHaveLength(4)

    // The turn-complete event also fires.
    const turnComplete = result.events.find((e) => (e as { kind?: string }).kind === 'turn-complete')
    expect(turnComplete).toBeTruthy()

    // Block Nodes were persisted under the Turn.
    const turnChildren = (await sidecar.send({
      id: '6',
      method: 'outline.getChildren',
      params: { workspaceId: ws.id, parentId: result.result.turnId },
    })) as Array<{ id: string; kind: string }>
    expect(turnChildren).toHaveLength(4)
    for (const b of turnChildren) {
      expect(b.kind).toBe('block')
    }
  }, 30000)
})
