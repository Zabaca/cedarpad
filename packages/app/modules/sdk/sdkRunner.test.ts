/**
 * Unit tests for the sidecar-side `sdkRunner` (v1.1 Shape B).
 *
 * The runner consumes events from the Claude Code SDK and translates
 * them into Block Nodes via the Thread engine. Tests mock the SDK at
 * its public interface (the `query()` AsyncGenerator + `interrupt()`
 * control method) — no real Claude API calls.
 *
 * Coverage:
 *   - text-delta accumulates into one Block Node's content
 *   - tool_use → tool_result lands as two Block Nodes under the Prompt
 *   - cancel mid-stream marks the Prompt cancelled
 *   - recycle preserves Prompt state (already-written Blocks survive)
 *   - first turn captures sessionId from system.init onto the bearer
 *   - second turn passes resume: sessionId (the PR #27 fix)
 *   - sdkMessageUuid stamped on the Prompt (last-write-wins)
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
import {
  createSdkRunner,
  type RunnerEvent,
  type SdkClient,
  type SdkQueryHandle,
} from './sdkRunner.ts'
import { BlockMetadataSchema, PromptMetadataSchema } from '../../src/contract.ts'

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
 * Seed a Shape B tree:
 *   bearer (Content Node, sdkSessionId: null) → prompt (Content Node)
 * Returns the prompt id.
 */
async function seedPrompt(opts: { bearerSessionId?: string | null } = {}): Promise<string> {
  const bearer = await store.createNode({
    parentId: null,
    content: 'topic',
    metadata: { sdkSessionId: opts.bearerSessionId ?? null },
  })
  const prompt = await store.createNode({
    parentId: bearer.id,
    content: 'hi',
    metadata: { state: 'streaming' },
  })
  return prompt.id
}

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
  yieldDelayMs?: number
  recorded: RecordedCall[]
}): SdkClient {
  return {
    async forkSession() {
      throw new Error('forkSession not exercised in sdkRunner tests')
    },
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

describe('sdkRunner.sendPrompt — Shape B writes Blocks under the Prompt', () => {
  it('translates a single assistant text block into one Block Node child of the Prompt', async () => {
    const promptId = await seedPrompt()

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }

    // Block Node was written under the Prompt — no Turn Node intermediate.
    const children = await store.getChildren(promptId)
    expect(children).toHaveLength(1)
    expect(children[0]!.kind).toBe('block')
    const meta = BlockMetadataSchema.parse(children[0]!.metadata)
    expect(meta.payload).toEqual({ kind: 'text', text: 'Hello world' })

    expect(events.map((e) => e.kind)).toEqual(['block-complete', 'prompt-complete'])

    // SDK was called with the API key and the read-only allowlist.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.apiKey).toBe('sk-ant-test')
    expect(recorded[0]!.cwd).toBe('/some/repo')
    expect(recorded[0]!.allowedTools).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('lands tool_use → tool_result as Block children of the Prompt', async () => {
    const promptId = await seedPrompt()
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
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'cedarpad outliner' }],
          },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'It is an outliner.' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })
    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: promptId,
      prompt: 'what is this repo?',
      repoPath: '/some/repo',
    })) {
      events.push(ev)
    }

    // Four Block Nodes (text, tool_use, tool_result, text) all children
    // of the Prompt directly.
    const children = await store.getChildren(promptId)
    expect(children).toHaveLength(4)
    const kinds = children.map((b) => BlockMetadataSchema.parse(b.metadata).payload.kind)
    expect(kinds).toEqual(['text', 'tool_use', 'tool_result', 'text'])

    const completes = events.filter((e) => e.kind === 'block-complete')
    expect(completes).toHaveLength(4)
  })

  it('streams text-delta events for incremental partial-assistant deltas', async () => {
    const promptId = await seedPrompt()
    const recorded: RecordedCall[] = []
    const sdk: SdkClient = {
      async forkSession() {
        throw new Error('forkSession not exercised in sdkRunner tests')
      },
      query: ({ prompt, options }) => {
        recorded.push({
          prompt: prompt as string,
          cwd: options?.cwd,
          allowedTools: options?.allowedTools,
          apiKey: options?.env?.ANTHROPIC_API_KEY,
        })
        const script: unknown[] = [
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hel' },
            },
          },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'lo' },
            },
          },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      events.push(ev)
    }

    const deltas = events.filter((e) => e.kind === 'text-delta')
    expect(deltas.map((d) => (d.kind === 'text-delta' ? d.content : ''))).toEqual(['Hel', 'lo'])
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

    const children = await store.getChildren(promptId)
    expect(children).toHaveLength(1)
    const meta = BlockMetadataSchema.parse(children[0]!.metadata)
    if (meta.payload.kind === 'text') {
      expect(meta.payload.text).toBe('Hello')
    } else {
      throw new Error('expected a text payload')
    }
  })

  it('cancel mid-stream stops further block emission and marks the Prompt cancelled', async () => {
    const promptId = await seedPrompt()
    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      yieldDelayMs: 30,
      script: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first block' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'never seen' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'never seen 2' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    const collected: RunnerEvent[] = []
    const stream = runner.sendPrompt({
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })
    for await (const ev of stream) {
      collected.push(ev)
      if (ev.kind === 'block-complete') {
        await runner.cancel(promptId)
      }
    }

    const promptAfter = await store.getNode(promptId)
    expect(PromptMetadataSchema.parse(promptAfter!.metadata).state).toBe('cancelled')

    const children = await store.getChildren(promptId)
    expect(children).toHaveLength(1)
  })

  it('recycle preserves Prompt state — already-persisted Blocks survive', async () => {
    const promptId = await seedPrompt()
    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first turn' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })

    for await (const _ev of runner.sendPrompt({
      threadId: promptId,
      prompt: 'first',
      repoPath: '/r',
    })) {
      void _ev
    }

    const before = await store.getChildren(promptId)
    expect(before).toHaveLength(1)

    await runner.recycle(promptId)

    const after = await store.getChildren(promptId)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(before[0]!.id)
  })

  it('marks Prompt state=done after natural completion', async () => {
    const promptId = await seedPrompt()
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }

    const promptAfter = await store.getNode(promptId)
    expect(PromptMetadataSchema.parse(promptAfter!.metadata).state).toBe('done')
  })

  it('emits NO_AUTH when neither subscription nor a stored key is available', async () => {
    const promptId = await seedPrompt()
    const emptyKeychain = createKeychainStore()
    const sdkSpy = vi.fn()
    const sdk: SdkClient = {
      async forkSession() {
        throw new Error('forkSession not exercised in sdkRunner tests')
      },
      query: (params) => {
        sdkSpy(params)
        throw new Error('should not have been called')
      },
    }
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain: emptyKeychain })

    const events: RunnerEvent[] = []
    for await (const ev of runner.sendPrompt({
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      events.push(ev)
    }
    expect(events).toEqual([{ kind: 'error', code: 'NO_AUTH', message: expect.any(String) }])
    expect(sdkSpy).not.toHaveBeenCalled()
  })

  it('subscription mode: invokes SDK without injecting ANTHROPIC_API_KEY', async () => {
    const promptId = await seedPrompt()
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      events.push(ev)
    }
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.apiKey).toBeUndefined()
    expect(events.filter((e) => e.kind === 'block-complete')).toHaveLength(1)
  })

  it('api-key mode: still injects ANTHROPIC_API_KEY from the keychain', async () => {
    const promptId = await seedPrompt()
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }
    expect(recorded[0]!.apiKey).toBe('sk-ant-test')
  })

  it('first turn captures sessionId from system.init and persists it onto the bearer', async () => {
    const promptId = await seedPrompt() // bearer has sdkSessionId: null
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.resume).toBeUndefined()

    // Bearer is the parent; check it carries the captured sessionId.
    const promptNode = await store.getNode(promptId)
    const bearerNode = await store.getNode(promptNode!.parentId!)
    expect((bearerNode!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-uuid-1')
  })

  it('second turn reads the persisted sessionId and passes resume to the SDK (PR #27 fix)', async () => {
    // Seed bearer with an already-persisted sessionId, then send under
    // a new sibling Prompt — the runner must see the bearer's session
    // and pass `resume`.
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-uuid-1' },
    })
    const prompt2 = await store.createNode({
      parentId: bearer.id,
      content: 'second',
      metadata: { state: 'streaming' },
    })

    const recorded: RecordedCall[] = []
    const sdk = fakeSdk({
      recorded,
      script: [
        { type: 'system', subtype: 'init', session_id: 'sess-uuid-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
        { type: 'result', subtype: 'success' },
      ],
    })
    const runner = createSdkRunner({ sdk, threadEngine: engine, keychain })
    for await (const _ev of runner.sendPrompt({
      threadId: prompt2.id,
      prompt: 'second',
      repoPath: '/r',
    })) {
      void _ev
    }

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.resume).toBe('sess-uuid-1')

    const bearerAfter = await store.getNode(bearer.id)
    expect((bearerAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-uuid-1')
  })

  it('stamps sdkMessageUuid on the Prompt from the assistant message uuid', async () => {
    const promptId = await seedPrompt()
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }

    const promptNode = await store.getNode(promptId)
    expect(PromptMetadataSchema.parse(promptNode!.metadata).sdkMessageUuid).toBe('msg-uuid-A')
  })

  it('multiple assistant messages in one Prompt: last uuid wins', async () => {
    const promptId = await seedPrompt()
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })) {
      void _ev
    }

    const promptNode = await store.getNode(promptId)
    expect(PromptMetadataSchema.parse(promptNode!.metadata).sdkMessageUuid).toBe('msg-uuid-B')
  })

  it('cancelled prompt still persists sessionId (sticks once captured)', async () => {
    const promptId = await seedPrompt()
    const recorded: RecordedCall[] = []
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
      threadId: promptId,
      prompt: 'hi',
      repoPath: '/r',
    })
    for await (const ev of stream) {
      if (ev.kind === 'block-complete') {
        await runner.cancel(promptId)
      }
    }

    const promptNode = await store.getNode(promptId)
    const bearerNode = await store.getNode(promptNode!.parentId!)
    expect((bearerNode!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-survives')
    expect(PromptMetadataSchema.parse(promptNode!.metadata).state).toBe('cancelled')
  })
})
