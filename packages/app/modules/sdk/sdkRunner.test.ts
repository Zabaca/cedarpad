/**
 * Unit tests for the sidecar-side `sdkRunner`.
 *
 * The runner consumes events from the Claude Code SDK and translates them
 * into Block Nodes via the Thread engine. Tests mock the SDK at its public
 * interface (the `query()` AsyncGenerator + `interrupt()` control method)
 * — no real Claude API calls.
 *
 * Coverage per slice 3 acceptance criteria:
 *   - text-delta accumulates into one Block Node's content
 *   - tool_use → tool_result lands as two Block Nodes
 *   - cancel mid-stream marks the Turn cancelled
 *   - recycle preserves Thread state (the Thread Root + already-written
 *     turns survive a recycle; only the SDK-process state is torn down)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { createOutlineStore, type OutlineStore } from '../outline/outlineStore.ts'
import { createThreadEngine, type ThreadEngine } from '../thread/threadEngine.ts'
import { createKeychainStore, type KeychainStore } from '../auth/keychainStore.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import { createSdkRunner, type RunnerEvent, type SdkClient, type SdkQueryHandle } from './sdkRunner.ts'
import { BlockMetadataSchema } from '../../src/contract.ts'

let store: OutlineStore
let engine: ThreadEngine
let keychain: KeychainStore
let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempWorktreeScoped('sdk-runner-')
  const db = createClient({ url: `file:${join(tmpDir, 'test.db')}` })
  await runMigrations(db)
  store = createOutlineStore(db)
  engine = createThreadEngine(store)
  keychain = createKeychainStore()
  keychain.setApiKey('sk-ant-test')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * Build a fake `SdkClient` whose `query` yields a scripted sequence of
 * SDK-side messages. The shape mirrors what `@anthropic-ai/claude-agent-sdk`
 * emits at runtime — `assistant` messages with `BetaContentBlock[]`, and a
 * terminal `result` message.
 */
type FakeSdkMessage =
  | {
      type: 'assistant'
      message: {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
        >
      }
    }
  | {
      type: 'user'
      message: {
        content: Array<{
          type: 'tool_result'
          tool_use_id: string
          content: unknown
          is_error?: boolean
        }>
      }
    }
  | { type: 'result'; subtype: 'success'; is_error?: boolean }
  | { type: 'system'; subtype: 'init' }

interface RecordedCall {
  prompt: string
  cwd?: string
  allowedTools?: string[]
  apiKey?: string
}

function fakeSdk(opts: {
  script: FakeSdkMessage[]
  /** ms delay between yielded messages — lets us observe streaming + cancel. */
  yieldDelayMs?: number
  recorded: RecordedCall[]
}): SdkClient {
  return {
    query: ({ prompt, options }) => {
      opts.recorded.push({
        prompt,
        cwd: options?.cwd,
        allowedTools: options?.allowedTools,
        apiKey: options?.env?.ANTHROPIC_API_KEY,
      })
      let interrupted = false
      const handle: SdkQueryHandle = {
        async interrupt() {
          interrupted = true
        },
        [Symbol.asyncIterator]() {
          let idx = 0
          return {
            async next() {
              if (interrupted) return { done: true, value: undefined as never }
              if (idx >= opts.script.length) return { done: true, value: undefined as never }
              if (opts.yieldDelayMs) {
                await new Promise((r) => setTimeout(r, opts.yieldDelayMs))
              }
              if (interrupted) return { done: true, value: undefined as never }
              const msg = opts.script[idx++]!
              return { done: false, value: msg as unknown }
            },
            async return() {
              interrupted = true
              return { done: true, value: undefined as never }
            },
          }
        },
      }
      return handle
    },
  }
}

describe('sdkRunner.sendPrompt', () => {
  it('translates a single assistant text block into one Block Node', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello world' }] },
        },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }

    // Block Node was written.
    const turns = await store.getChildren(root.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.kind).toBe('turn')
    const blocks = await store.getChildren(turns[0]!.id)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('block')
    const meta = BlockMetadataSchema.parse(blocks[0]!.metadata)
    expect(meta.payload).toEqual({ kind: 'text', text: 'Hello world' })

    // Events emitted in order.
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual(['block-complete', 'turn-complete'])

    // SDK was called with the API key and the read-only allowlist.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.apiKey).toBe('sk-ant-test')
    expect(recorded[0]!.cwd).toBe('/some/repo')
    expect(recorded[0]!.allowedTools).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('lands tool_use → tool_result as two Block Nodes', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Looking at README' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'README.md' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'cedarpad outliner' },
            ],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'It is an outliner.' }] },
        },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'what is this repo?',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }

    // Single Turn, four Block Nodes (text, tool_use, tool_result, text).
    const turns = await store.getChildren(root.id)
    expect(turns).toHaveLength(1)
    const blocks = await store.getChildren(turns[0]!.id)
    expect(blocks).toHaveLength(4)
    const kinds = blocks.map((b) => BlockMetadataSchema.parse(b.metadata).payload.kind)
    expect(kinds).toEqual(['text', 'tool_use', 'tool_result', 'text'])

    // Block-complete fires once per block.
    const completes = events.filter((e) => e.kind === 'block-complete')
    expect(completes).toHaveLength(4)
  })

  it('streams text-delta events for incremental partial-assistant deltas', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk: SdkClient = {
      query: ({ prompt, options }) => {
        recorded.push({
          prompt,
          cwd: options?.cwd,
          allowedTools: options?.allowedTools,
          apiKey: options?.env?.ANTHROPIC_API_KEY,
        })
        // Emit a partial-assistant stream event sequence (text deltas), then
        // a final assistant message with the full text, then a result.
        const script: unknown[] = [
          {
            type: 'stream_event',
            event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
          },
          {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
          },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Hello' }] },
          },
          { type: 'result', subtype: 'success' },
        ]
        return {
          async interrupt() {
            /* no-op */
          },
          [Symbol.asyncIterator]() {
            let i = 0
            return {
              async next() {
                if (i >= script.length) return { done: true, value: undefined as never }
                const v = script[i++]
                return { done: false, value: v }
              },
              async return() {
                return { done: true, value: undefined as never }
              },
            }
          },
        }
      },
    }
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }

    const deltas = events.filter((e) => e.kind === 'text-delta')
    expect(deltas.map((d) => d.kind === 'text-delta' && d.content)).toEqual(['Hel', 'lo'])
    // All deltas share a single (in-flight) blockId, then block-complete
    // names the same id.
    const deltaIds = new Set(
      deltas
        .filter((e): e is RunnerEvent & { kind: 'text-delta' } => e.kind === 'text-delta')
        .map((e) => e.blockId),
    )
    expect(deltaIds.size).toBe(1)
    const completes = events.filter((e) => e.kind === 'block-complete')
    expect(completes).toHaveLength(1)
    if (completes[0]!.kind === 'block-complete') {
      expect(deltaIds.has(completes[0]!.blockId)).toBe(true)
    }

    // Persisted Block Node has the accumulated final text.
    const turns = await store.getChildren(root.id)
    const blocks = await store.getChildren(turns[0]!.id)
    expect(blocks).toHaveLength(1)
    const meta = BlockMetadataSchema.parse(blocks[0]!.metadata)
    if (meta.payload.kind === 'text') {
      expect(meta.payload.text).toBe('Hello')
    } else {
      throw new Error('expected a text payload')
    }
  })

  it('cancel mid-stream stops further block emission and marks the Turn cancelled', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    // Yield slowly so the consumer's cancel races ahead of the second message.
    const sdk = fakeSdk({
      recorded,
      yieldDelayMs: 30,
      script: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'first block' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'never seen' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'never seen 2' }] },
        },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const collected: RunnerEvent[] = []
    const stream = runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/some/repo',
    })
    for await (const ev of stream) {
      collected.push(ev)
      if (ev.kind === 'block-complete') {
        // Cancel right after the first block; the stream should stop.
        await runner.cancel(root.id)
      }
    }

    const turns = await store.getChildren(root.id)
    expect(turns).toHaveLength(1)
    const turnNode = turns[0]!
    expect(turnNode.kind).toBe('turn')
    // Turn metadata reflects cancellation via the slice 4 lifecycle state.
    const turnMeta = turnNode.metadata as { role?: string; state?: string; cancelled?: boolean }
    expect(turnMeta.state).toBe('cancelled')
    // Legacy boolean is still set so slice 3 readers don't break.
    expect(turnMeta.cancelled).toBe(true)

    // Only one block was written.
    const blocks = await store.getChildren(turnNode.id)
    expect(blocks).toHaveLength(1)
  })

  it('recycle preserves Thread state — already-persisted turns survive', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'first turn' }] },
        },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    // First call: writes a Turn + Block.
    for await (const _ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'first',
      repoPath: '/some/repo',
    })) {
      void _ev
    }

    const turnsBefore = await store.getChildren(root.id)
    expect(turnsBefore).toHaveLength(1)
    const blocksBefore = await store.getChildren(turnsBefore[0]!.id)
    expect(blocksBefore).toHaveLength(1)

    // Recycle.
    await runner.recycle(root.id)

    // Tree is intact post-recycle. The recycle is a process-level reset,
    // not a data reset.
    const turnsAfter = await store.getChildren(root.id)
    expect(turnsAfter).toHaveLength(1)
    expect(turnsAfter[0]!.id).toBe(turnsBefore[0]!.id)
    const blocksAfter = await store.getChildren(turnsAfter[0]!.id)
    expect(blocksAfter).toHaveLength(1)
    expect(blocksAfter[0]!.id).toBe(blocksBefore[0]!.id)
  })

  it('marks Turn state=done after natural completion (slice 4 lifecycle)', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })
    for await (const _ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }

    const turns = await store.getChildren(root.id)
    const turnMeta = turns[0]!.metadata as { state?: string }
    expect(turnMeta.state).toBe('done')
  })

  it('emits an error event if no API key is configured', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const emptyKeychain = createKeychainStore()
    const sdkSpy = vi.fn()
    const sdk: SdkClient = {
      query: (params) => {
        sdkSpy(params)
        throw new Error('should not have been called')
      },
    }
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain: emptyKeychain })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }
    expect(events).toEqual([
      { kind: 'error', code: 'NO_API_KEY', message: expect.any(String) },
    ])
    expect(sdkSpy).not.toHaveBeenCalled()
  })
})
