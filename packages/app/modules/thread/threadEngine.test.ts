/**
 * Tests for the v1.1 Shape B `threadEngine`.
 *
 * The single TDD'd entry point is `sendPrompt` — it owns the decision
 * tree for "what should pressing Cmd+Enter on this Content Node do?"
 *
 * Coverage:
 *   - Root-level Content Node → "Or" semantics: self-stamps as
 *     session-bearer, creates an empty child Prompt, does NOT call SDK.
 *   - Non-root Content Node whose parent is NOT a session-bearer →
 *     parent gets stamped (sdkSessionId: null), Prompt is sent.
 *   - Non-root Content Node whose parent IS a session-bearer → no
 *     re-stamp; Prompt is sent.
 *   - Deeply nested (grandparent is the bearer) → parent gets stamped
 *     because v1.1 stamps the IMMEDIATE parent on a non-root send. The
 *     runner then resolves the nearest bearer via ancestor walk for
 *     `resume:` purposes.
 *
 * Plus the smaller helpers used by the SDK runner:
 *   - `appendBlock` writes Block children directly under a Prompt.
 *   - `markPrompt{Streaming,Done,Cancelled,Interrupted}` round-trip.
 *   - `getSessionBearerSdkSessionId` walks ancestry.
 *   - `setSessionBearerSdkSessionId` writes to the nearest bearer.
 *   - `setPromptSdkMessageUuid` last-write-wins.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { createOutlineStore, type OutlineStore } from '../outline/outlineStore.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import {
  createThreadEngine,
  type ThreadEngine,
  type SendPromptRunner,
} from './threadEngine.ts'
import {
  BlockMetadataSchema,
  PromptMetadataSchema,
  SessionBearerMetadataSchema,
  type RunnerEvent,
} from '../../src/contract.ts'

let store: OutlineStore
let engine: ThreadEngine
let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempWorktreeScoped('thread-engine-')
  const db = createClient({ url: `file:${join(tmpDir, 'test.db')}` })
  await runMigrations(db)
  store = createOutlineStore(db)
  engine = createThreadEngine(store)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

interface RunnerCall {
  threadId: string
  prompt: string
  repoPath: string
}

/**
 * Stub runner whose `sendPrompt` records the call and yields a fixed
 * event sequence. `sendPrompt` tests don't drain the iterable — they
 * only need to assert "the runner was invoked with these args" — but a
 * couple of integration-y tests do iterate.
 */
function fakeRunner(opts: { events?: RunnerEvent[] } = {}): {
  runner: SendPromptRunner
  calls: RunnerCall[]
} {
  const calls: RunnerCall[] = []
  const events = opts.events ?? []
  return {
    calls,
    runner: {
      sendPrompt(input) {
        calls.push(input)
        return {
          [Symbol.asyncIterator]() {
            let i = 0
            return {
              async next() {
                if (i >= events.length) return { done: true, value: undefined as never }
                return { done: false, value: events[i++]! }
              },
              async return() {
                return { done: true, value: undefined as never }
              },
            }
          },
        }
      },
      async cancel() {
        /* noop */
      },
    },
  }
}

describe('threadEngine.sendPrompt — root-level "Or" semantics', () => {
  it('self-stamps as session-bearer, creates an empty child Prompt, does NOT call the SDK', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    const { runner, calls } = fakeRunner()

    const out = await engine.sendPrompt({
      contentNodeId: root.id,
      prompt: '(unused for bootstrap)',
      repoPath: '/repo',
      runner,
    })

    expect(out.kind).toBe('bootstrapped')
    if (out.kind !== 'bootstrapped') throw new Error('expected bootstrapped')
    expect(out.sessionBearerNodeId).toBe(root.id)

    // Root is a session-bearer.
    const stamped = await store.getNode(root.id)
    const bearerMeta = SessionBearerMetadataSchema.parse(stamped!.metadata)
    expect(bearerMeta).toHaveProperty('sdkSessionId')
    expect(bearerMeta.sdkSessionId).toBeNull()

    // Empty child Prompt was created and is the focus.
    const newChild = await store.getNode(out.newPromptNodeId)
    expect(newChild).not.toBeNull()
    expect(newChild!.kind).toBe('content')
    expect(newChild!.parentId).toBe(root.id)
    expect(newChild!.content).toBe('')

    // Runner was NOT called.
    expect(calls).toHaveLength(0)
  })

  it('idempotent on a root that is already a session-bearer (no overwrite)', async () => {
    const root = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-existing' },
    })
    const { runner, calls } = fakeRunner()

    const out = await engine.sendPrompt({
      contentNodeId: root.id,
      prompt: '',
      repoPath: '/r',
      runner,
    })

    expect(out.kind).toBe('bootstrapped')
    const stamped = await store.getNode(root.id)
    expect((stamped!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-existing')
    expect(calls).toHaveLength(0)
  })
})

describe('threadEngine.sendPrompt — parent is not a session-bearer', () => {
  it('stamps the parent as a session-bearer (sdkSessionId: null) and invokes the runner', async () => {
    const parent = await store.createNode({ parentId: null, content: 'topic' })
    const child = await store.createNode({
      parentId: parent.id,
      content: 'what is in README?',
    })
    const { runner, calls } = fakeRunner()

    const out = await engine.sendPrompt({
      contentNodeId: child.id,
      prompt: 'what is in README?',
      repoPath: '/repo',
      runner,
    })

    expect(out.kind).toBe('sent')
    if (out.kind !== 'sent') throw new Error('expected sent')
    expect(out.promptNodeId).toBe(child.id)
    expect(out.sessionBearerNodeId).toBe(parent.id)

    // Parent now carries the bearer marker.
    const parentAfter = await store.getNode(parent.id)
    const parentMeta = SessionBearerMetadataSchema.parse(parentAfter!.metadata)
    expect(parentMeta).toHaveProperty('sdkSessionId')
    expect(parentMeta.sdkSessionId).toBeNull()

    // Prompt is in streaming state.
    const promptAfter = await store.getNode(child.id)
    const promptMeta = PromptMetadataSchema.parse(promptAfter!.metadata)
    expect(promptMeta.state).toBe('streaming')

    // Runner was invoked with the right args.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      threadId: child.id,
      prompt: 'what is in README?',
      repoPath: '/repo',
    })
  })
})

describe('threadEngine.sendPrompt — parent is already a session-bearer', () => {
  it('does NOT re-stamp the parent and invokes the runner', async () => {
    const parent = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-existing' },
    })
    const child = await store.createNode({
      parentId: parent.id,
      content: 'follow up',
    })
    const { runner, calls } = fakeRunner()

    const out = await engine.sendPrompt({
      contentNodeId: child.id,
      prompt: 'follow up',
      repoPath: '/r',
      runner,
    })

    expect(out.kind).toBe('sent')
    const parentAfter = await store.getNode(parent.id)
    expect((parentAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-existing')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.threadId).toBe(child.id)
  })
})

describe('threadEngine.sendPrompt — deeply nested', () => {
  it('stamps the IMMEDIATE parent as bearer (ancestor-walk happens at runner read)', async () => {
    // A → B → C; A is the existing bearer; user sends from C.
    // The send stamps B as a bearer with sdkSessionId: null (immediate
    // parent stamping policy) — but the runner's `getSessionBearerSdkSessionId`
    // walk will find A (because A has a real sessionId, and B's is null).
    const a = await store.createNode({
      parentId: null,
      content: 'a',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const b = await store.createNode({ parentId: a.id, content: 'b' })
    const c = await store.createNode({ parentId: b.id, content: 'send me' })
    const { runner, calls } = fakeRunner()

    const out = await engine.sendPrompt({
      contentNodeId: c.id,
      prompt: 'send me',
      repoPath: '/r',
      runner,
    })

    expect(out.kind).toBe('sent')
    if (out.kind !== 'sent') throw new Error('expected sent')
    // Immediate parent B is now a bearer (with null sessionId).
    expect(out.sessionBearerNodeId).toBe(b.id)
    const bAfter = await store.getNode(b.id)
    expect((bAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBeNull()

    // Runner was invoked.
    expect(calls).toHaveLength(1)
  })
})

describe('threadEngine.sendPrompt — error cases', () => {
  it('throws when contentNodeId is unknown', async () => {
    const { runner } = fakeRunner()
    await expect(
      engine.sendPrompt({ contentNodeId: 'nope', prompt: 'x', repoPath: '/r', runner }),
    ).rejects.toThrow(/not found/)
  })

  it('throws when contentNodeId is a Block Node', async () => {
    const block = await store.createNode({
      parentId: null,
      kind: 'block',
      content: '',
      metadata: { role: 'block', payload: { kind: 'text', text: 'hi' } },
    })
    const { runner } = fakeRunner()
    await expect(
      engine.sendPrompt({ contentNodeId: block.id, prompt: 'x', repoPath: '/r', runner }),
    ).rejects.toThrow(/Content Node/)
  })
})

describe('threadEngine.appendBlock', () => {
  it('writes a Block child of the Prompt with the right metadata shape', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    const prompt = await store.createNode({ parentId: root.id, content: 'hi' })

    const block = await engine.appendBlock(prompt.id, {
      kind: 'tool_use',
      toolName: 'Read',
      toolUseId: 'tu1',
      input: { path: 'README.md' },
    })

    expect(block.kind).toBe('block')
    expect(block.parentId).toBe(prompt.id)
    const meta = BlockMetadataSchema.parse(block.metadata)
    expect(meta.payload).toEqual({
      kind: 'tool_use',
      toolName: 'Read',
      toolUseId: 'tu1',
      input: { path: 'README.md' },
    })

    const children = await store.getChildren(prompt.id)
    expect(children).toHaveLength(1)
    expect(children[0]!.id).toBe(block.id)
  })

  it('preserves order across multiple appends (chained prevSibling)', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    const prompt = await store.createNode({ parentId: root.id, content: 'hi' })

    const b1 = await engine.appendBlock(prompt.id, { kind: 'text', text: 'a' })
    const b2 = await engine.appendBlock(prompt.id, { kind: 'text', text: 'b' })
    const b3 = await engine.appendBlock(prompt.id, { kind: 'text', text: 'c' })

    const children = await store.getChildren(prompt.id)
    expect(children.map((c) => c.id)).toEqual([b1.id, b2.id, b3.id])
  })
})

describe('threadEngine markPrompt* lifecycle', () => {
  async function makePrompt(): Promise<string> {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    const p = await store.createNode({ parentId: root.id, content: 'hi' })
    return p.id
  }

  it('streaming → done', async () => {
    const id = await makePrompt()
    await engine.markPromptStreaming(id)
    const after = await engine.markPromptDone(id)
    expect(PromptMetadataSchema.parse(after.metadata).state).toBe('done')
  })

  it('streaming → cancelled', async () => {
    const id = await makePrompt()
    await engine.markPromptStreaming(id)
    const after = await engine.markPromptCancelled(id)
    expect(PromptMetadataSchema.parse(after.metadata).state).toBe('cancelled')
  })

  it('streaming → interrupted', async () => {
    const id = await makePrompt()
    await engine.markPromptStreaming(id)
    const after = await engine.markPromptInterrupted(id)
    expect(PromptMetadataSchema.parse(after.metadata).state).toBe('interrupted')
  })
})

describe('threadEngine session-bearer helpers', () => {
  it('getSessionBearerSdkSessionId returns null when no ancestor is a bearer', async () => {
    const a = await store.createNode({ parentId: null, content: 'a' })
    const b = await store.createNode({ parentId: a.id, content: 'b' })
    expect(await engine.getSessionBearerSdkSessionId(b.id)).toBeNull()
  })

  it('returns null when the bearer was just stamped (sdkSessionId is still null)', async () => {
    const a = await store.createNode({
      parentId: null,
      content: 'a',
      metadata: { sdkSessionId: null },
    })
    const b = await store.createNode({ parentId: a.id, content: 'b' })
    expect(await engine.getSessionBearerSdkSessionId(b.id)).toBeNull()
  })

  it('returns the nearest ancestor bearer that has a real sessionId', async () => {
    const a = await store.createNode({
      parentId: null,
      content: 'a',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const b = await store.createNode({ parentId: a.id, content: 'b' })
    const c = await store.createNode({ parentId: b.id, content: 'c' })
    expect(await engine.getSessionBearerSdkSessionId(c.id)).toBe('sess-a')
  })

  it('setSessionBearerSdkSessionId writes to the nearest bearer ancestor', async () => {
    const a = await store.createNode({
      parentId: null,
      content: 'a',
      metadata: { sdkSessionId: null },
    })
    const b = await store.createNode({ parentId: a.id, content: 'b' })
    await engine.setSessionBearerSdkSessionId(b.id, 'sess-fresh')
    const aAfter = await store.getNode(a.id)
    expect((aAfter!.metadata as { sdkSessionId?: unknown }).sdkSessionId).toBe('sess-fresh')
  })

  it('setPromptSdkMessageUuid stamps last-write-wins', async () => {
    const a = await store.createNode({
      parentId: null,
      content: 'a',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const p = await store.createNode({ parentId: a.id, content: 'hi' })
    await engine.setPromptSdkMessageUuid(p.id, 'msg-1')
    await engine.setPromptSdkMessageUuid(p.id, 'msg-2')
    const after = await store.getNode(p.id)
    expect(PromptMetadataSchema.parse(after!.metadata).sdkMessageUuid).toBe('msg-2')
  })
})
