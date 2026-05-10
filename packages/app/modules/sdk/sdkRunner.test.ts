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
      uuid?: string
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
  | { type: 'system'; subtype: 'init'; session_id?: string }

interface RecordedCall {
  prompt: string
  cwd?: string
  allowedTools?: string[]
  apiKey?: string
  resume?: string
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
        prompt: prompt as string,
        cwd: options?.cwd,
        allowedTools: options?.allowedTools,
        apiKey: options?.env?.ANTHROPIC_API_KEY,
        resume: options?.resume as string | undefined,
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

  it('emits NO_AUTH when neither subscription nor a stored key is available', async () => {
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
    // No `getAuthMode` → runner falls back to keychain-only check; empty
    // keychain ⇒ mode is 'none'.
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
      { kind: 'error', code: 'NO_AUTH', message: expect.any(String) },
    ])
    expect(sdkSpy).not.toHaveBeenCalled()
  })

  it('subscription mode: invokes SDK without injecting ANTHROPIC_API_KEY', async () => {
    // Post-merge auth fix: when the user has a Claude Code OAuth login
    // (subscription), the SDK reads its own credentials file. cedarpad
    // must NOT set ANTHROPIC_API_KEY in that case — doing so would
    // override the subscription auth with whatever placeholder/empty
    // value our keychain holds.
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const emptyKeychain = createKeychainStore()
    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({
      sdk,
      threadEngine: engine,
      keychain: emptyKeychain,
      getAuthMode: () => 'subscription',
    })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }

    // SDK was invoked successfully.
    expect(recorded).toHaveLength(1)
    // Critical: no ANTHROPIC_API_KEY was set on the SDK env. The
    // recorder reads `options.env.ANTHROPIC_API_KEY`; in subscription
    // mode the runner doesn't set it, so this is undefined.
    expect(recorded[0]!.apiKey).toBeUndefined()
    // Block was still emitted normally.
    const completes = events.filter((e) => e.kind === 'block-complete')
    expect(completes).toHaveLength(1)
  })

  it('api-key mode: still injects ANTHROPIC_API_KEY from the keychain', async () => {
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
    const runner = createSdkRunner({
      sdk,
      threadEngine: engine,
      keychain,
      getAuthMode: () => 'api-key',
    })

    for await (const _ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }

    expect(recorded[0]!.apiKey).toBe('sk-ant-test')
  })

  it('first turn captures sessionId from system.init and persists it to the Thread Root', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-uuid-1' },
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

    // First call must NOT have sent `resume` — there was no prior session.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.resume).toBeUndefined()

    // Thread Root metadata now carries the sessionId.
    const rootAfter = await store.getNode(root.id)
    expect((rootAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-uuid-1')
  })

  it('second turn reads the persisted sessionId and passes resume to the SDK', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-uuid-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    // First turn — runner captures sessionId from system.init.
    for await (const _ev of runner.sendPrompt({
      threadId: root.id,
      prompt: 'first',
      repoPath: '/r',
    })) {
      void _ev
    }
    expect(recorded[0]!.resume).toBeUndefined()

    // Drive a second turn with a fresh fake script. The SDK still emits
    // a system.init on resume; we want to confirm the runner passes
    // `resume: <prior sessionId>` on this second call.
    const recorded2: RecordedCall[] = []
    const sdk2 = fakeSdk({
      recorded: recorded2,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-uuid-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner2 = createSdkRunner({ sdk: sdk2, threadEngine: engine, keychain })
    for await (const _ev of runner2.sendPrompt({
      threadId: root.id,
      prompt: 'second',
      repoPath: '/r',
    })) {
      void _ev
    }

    expect(recorded2).toHaveLength(1)
    expect(recorded2[0]!.resume).toBe('sess-uuid-1')

    // sessionId on the Thread Root is unchanged.
    const rootAfter = await store.getNode(root.id)
    expect((rootAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-uuid-1')
  })

  it('stamps sdkMessageUuid on the Turn Node from the assistant message uuid', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        {
          type: 'assistant',
          uuid: 'msg-uuid-A',
          message: { content: [{ type: 'text', text: 'hello' }] },
        },
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
    expect(turns).toHaveLength(1)
    const turnMeta = turns[0]!.metadata as { sdkMessageUuid?: unknown }
    expect(turnMeta.sdkMessageUuid).toBe('msg-uuid-A')
  })

  it('multiple assistant messages in one Turn: last uuid wins (resumeSessionAt boundary)', async () => {
    // SDK turns can include multiple assistant messages around tool calls.
    // For "branch from this Turn" wiring we want the LAST assistant
    // message of the Turn so resumed history covers the whole Turn.
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        {
          type: 'assistant',
          uuid: 'msg-uuid-A',
          message: {
            content: [
              { type: 'text', text: 'looking…' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'README.md' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'cedarpad' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-uuid-B',
          message: { content: [{ type: 'text', text: 'done' }] },
        },
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
    const turnMeta = turns[0]!.metadata as { sdkMessageUuid?: unknown }
    expect(turnMeta.sdkMessageUuid).toBe('msg-uuid-B')
  })

  it('cancelled turn still persists sessionId (sticks once captured)', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const recorded: RecordedCall[] = []
    // Yield slowly so the cancel races ahead of the second message —
    // but the system.init lands first, so its session_id should be
    // persisted before cancel fires.
    const sdk = fakeSdk({
      recorded,
      yieldDelayMs: 30,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-survives' },
        {
          type: 'assistant',
          uuid: 'msg-1',
          message: { content: [{ type: 'text', text: 'first block' }] },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          message: { content: [{ type: 'text', text: 'never seen' }] },
        },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const stream = runner.sendPrompt({
      threadId: root.id,
      prompt: 'hi',
      repoPath: '/r',
    })
    for await (const ev of stream) {
      if (ev.kind === 'block-complete') {
        await runner.cancel(root.id)
      }
    }

    // sessionId was captured before cancel landed and survives.
    const rootAfter = await store.getNode(root.id)
    expect((rootAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-survives')

    // Turn was marked cancelled per existing behaviour.
    const turns = await store.getChildren(root.id)
    const turnMeta = turns[0]!.metadata as { state?: string }
    expect(turnMeta.state).toBe('cancelled')
  })

  it('errored turn does not unset a previously-captured sessionId', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    // First turn: captures session id.
    const recorded1: RecordedCall[] = []
    const sdk1 = fakeSdk({
      recorded: recorded1,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-keep' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner1 = createSdkRunner({ sdk: sdk1, threadEngine: engine, keychain })
    for await (const _ev of runner1.sendPrompt({
      threadId: root.id,
      prompt: 'first',
      repoPath: '/r',
    })) {
      void _ev
    }

    // Second turn: SDK throws mid-stream. Runner emits an SDK_RUNTIME
    // error but the prior sessionId must still be on the Thread Root.
    const sdkErr: SdkClient = {
      query: () => ({
        async interrupt() {
          /* no-op */
        },
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              throw new Error('boom')
            },
            async return() {
              return { done: true, value: undefined as never }
            },
          }
        },
      }),
    }
    const runner2 = createSdkRunner({ sdk: sdkErr, threadEngine: engine, keychain })
    const events: RunnerEvent[] = []
    for await (const ev of runner2.sendPrompt({
      threadId: root.id,
      prompt: 'second',
      repoPath: '/r',
    })) {
      events.push(ev)
    }
    // Sanity: the runner surfaced the error (it doesn't matter which
    // exact code; the contract is that sessionId persistence is
    // independent of run success).
    expect(events.some((e) => e.kind === 'error')).toBe(true)

    const rootAfter = await store.getNode(root.id)
    expect((rootAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-keep')
  })
})
