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
  BranchMetadataSchema,
  PromptMetadataSchema,
  SessionBearerMetadataSchema,
  type RunnerEvent,
} from '../../src/contract.ts'
import type {
  SdkClient,
  SdkForkSessionOptions,
} from '../sdk/sdkRunner.ts'

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

// ----- forkAtPrompt (Cmd+Shift+B) -----

interface ForkCall {
  sessionId: string
  options?: SdkForkSessionOptions
}

function fakeSdk(opts: { forkedSessionId?: string } = {}): {
  client: SdkClient
  forkCalls: ForkCall[]
} {
  const forkCalls: ForkCall[] = []
  return {
    forkCalls,
    client: {
      query() {
        throw new Error('query not exercised in forkAtPrompt tests')
      },
      async forkSession(sessionId, options) {
        forkCalls.push({ sessionId, options })
        return { sessionId: opts.forkedSessionId ?? `fork-of-${sessionId}` }
      },
    },
  }
}

describe('threadEngine.forkAtPrompt — Cmd+Shift+B', () => {
  it('source = Prompt, no existing Branches container: materializes one and a Branch with fork metadata', async () => {
    // bearer (sdkSessionId: 'sess-a') → prompt (sdkMessageUuid: 'msg-1')
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const prompt = await store.createNode({
      parentId: bearer.id,
      content: 'hello',
      metadata: { state: 'done', sdkMessageUuid: 'msg-1' },
    })
    const { client, forkCalls } = fakeSdk({ forkedSessionId: 'sess-fork-1' })

    const out = await engine.forkAtPrompt({
      sourceNodeId: prompt.id,
      sdk: client,
      repoPath: '/repo',
    })

    // Eager fork called with the right session + message uuid.
    expect(forkCalls).toHaveLength(1)
    expect(forkCalls[0]!.sessionId).toBe('sess-a')
    expect(forkCalls[0]!.options?.upToMessageId).toBe('msg-1')

    // Branches container is the immediate next sibling of the Prompt.
    const bearerChildren = await store.getChildren(bearer.id)
    const promptIdx = bearerChildren.findIndex((n) => n.id === prompt.id)
    expect(promptIdx).toBeGreaterThanOrEqual(0)
    const next = bearerChildren[promptIdx + 1]
    expect(next).toBeDefined()
    expect(next!.kind).toBe('branches')
    expect(next!.id).toBe(out.branchesContainerId)

    // Branch is a Content Node under the Branches container.
    const containerChildren = await store.getChildren(next!.id)
    expect(containerChildren).toHaveLength(1)
    const branchNode = containerChildren[0]!
    expect(branchNode.id).toBe(out.branchNodeId)
    expect(branchNode.kind).toBe('content')

    const meta = BranchMetadataSchema.parse(branchNode.metadata)
    expect(meta.sdkSessionId).toBe('sess-fork-1')
    expect(meta.branchedFromMessageUuid).toBe('msg-1')
    expect(meta.branchedFromNodeId).toBe(prompt.id)

    // Empty Prompt child of the Branch was created and is the focus.
    const branchChildren = await store.getChildren(branchNode.id)
    expect(branchChildren).toHaveLength(1)
    expect(branchChildren[0]!.id).toBe(out.promptNodeId)
    expect(branchChildren[0]!.kind).toBe('content')
    expect(branchChildren[0]!.content).toBe('')
  })

  it('source = Prompt, EXISTING adjacent Branches container: adds a Branch alongside, no second container', async () => {
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const prompt = await store.createNode({
      parentId: bearer.id,
      content: 'hello',
      metadata: { state: 'done', sdkMessageUuid: 'msg-1' },
    })
    // Pre-existing Branches container as immediate next sibling.
    const container = await store.createNode({
      parentId: bearer.id,
      prevSiblingId: prompt.id,
      kind: 'branches',
      content: '',
    })
    // Pre-existing Branch inside the container.
    const existingBranch = await store.createNode({
      parentId: container.id,
      kind: 'content',
      content: 'Branch 1',
      metadata: {
        sdkSessionId: 'prev-fork',
        branchedFromMessageUuid: 'msg-1',
        branchedFromNodeId: prompt.id,
      },
    })

    const { client, forkCalls } = fakeSdk({ forkedSessionId: 'sess-fork-2' })
    const out = await engine.forkAtPrompt({
      sourceNodeId: prompt.id,
      sdk: client,
      repoPath: '/r',
    })

    // No new container — reused the existing one.
    expect(out.branchesContainerId).toBe(container.id)
    const bearerChildren = await store.getChildren(bearer.id)
    const containers = bearerChildren.filter((n) => n.kind === 'branches')
    expect(containers).toHaveLength(1)

    // Two Branches now under the container, in order.
    const containerChildren = await store.getChildren(container.id)
    expect(containerChildren.map((c) => c.id)).toEqual([existingBranch.id, out.branchNodeId])

    expect(forkCalls).toHaveLength(1)
    expect(forkCalls[0]!.sessionId).toBe('sess-a')
  })

  it('source = session-bearer root (no fork point): fresh Branch with branchedFromMessageUuid: null', async () => {
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-a' },
    })

    const { client, forkCalls } = fakeSdk({ forkedSessionId: 'sess-fresh' })
    const out = await engine.forkAtPrompt({
      sourceNodeId: bearer.id,
      sdk: client,
      repoPath: '/r',
    })

    // SDK fork still called — eager — but with no upToMessageId.
    expect(forkCalls).toHaveLength(1)
    expect(forkCalls[0]!.sessionId).toBe('sess-a')
    expect(forkCalls[0]!.options?.upToMessageId).toBeUndefined()

    // Branches container is a sibling of the bearer (at root level).
    const rootChildren = await store.getChildren(null)
    const idx = rootChildren.findIndex((n) => n.id === bearer.id)
    const next = rootChildren[idx + 1]
    expect(next).toBeDefined()
    expect(next!.kind).toBe('branches')

    const branchChildren = await store.getChildren(next!.id)
    expect(branchChildren).toHaveLength(1)
    const branch = branchChildren[0]!
    const meta = BranchMetadataSchema.parse(branch.metadata)
    expect(meta.sdkSessionId).toBe('sess-fresh')
    expect(meta.branchedFromMessageUuid).toBeNull()
    expect(meta.branchedFromNodeId).toBe(bearer.id)
  })

  it('source = Prompt inside a Branch: forks the BRANCH session id, materializes a Branches container at that depth', async () => {
    // Root bearer → Prompt (msg-root) → Branches → Branch(sess-fork-A) →
    //   Prompt (msg-inner) — branch from the inner Prompt.
    const root = await store.createNode({
      parentId: null,
      content: 'root',
      metadata: { sdkSessionId: 'sess-root' },
    })
    const rootPrompt = await store.createNode({
      parentId: root.id,
      content: 'p1',
      metadata: { state: 'done', sdkMessageUuid: 'msg-root' },
    })
    const branchesContainer = await store.createNode({
      parentId: root.id,
      prevSiblingId: rootPrompt.id,
      kind: 'branches',
      content: '',
    })
    const innerBranch = await store.createNode({
      parentId: branchesContainer.id,
      kind: 'content',
      content: 'Branch 1',
      metadata: {
        sdkSessionId: 'sess-fork-A',
        branchedFromMessageUuid: 'msg-root',
        branchedFromNodeId: rootPrompt.id,
      },
    })
    const innerPrompt = await store.createNode({
      parentId: innerBranch.id,
      content: 'inner',
      metadata: { state: 'done', sdkMessageUuid: 'msg-inner' },
    })

    const { client, forkCalls } = fakeSdk({ forkedSessionId: 'sess-fork-B' })
    const out = await engine.forkAtPrompt({
      sourceNodeId: innerPrompt.id,
      sdk: client,
      repoPath: '/r',
    })

    // Fork base is the BRANCH's session id, not root's.
    expect(forkCalls).toHaveLength(1)
    expect(forkCalls[0]!.sessionId).toBe('sess-fork-A')
    expect(forkCalls[0]!.options?.upToMessageId).toBe('msg-inner')

    // Branches container materialized as immediate next sibling of innerPrompt.
    const branchChildren = await store.getChildren(innerBranch.id)
    const idx = branchChildren.findIndex((n) => n.id === innerPrompt.id)
    const next = branchChildren[idx + 1]
    expect(next).toBeDefined()
    expect(next!.kind).toBe('branches')
    expect(next!.id).toBe(out.branchesContainerId)

    const nestedBranch = (await store.getChildren(next!.id))[0]!
    const meta = BranchMetadataSchema.parse(nestedBranch.metadata)
    expect(meta.sdkSessionId).toBe('sess-fork-B')
    expect(meta.branchedFromMessageUuid).toBe('msg-inner')
    expect(meta.branchedFromNodeId).toBe(innerPrompt.id)
  })

  it('returns { branchNodeId, promptNodeId, branchesContainerId } so the renderer can focus the empty Prompt', async () => {
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const prompt = await store.createNode({
      parentId: bearer.id,
      content: 'p',
      metadata: { state: 'done', sdkMessageUuid: 'msg-1' },
    })
    const { client } = fakeSdk({ forkedSessionId: 'sess-fork' })
    const out = await engine.forkAtPrompt({
      sourceNodeId: prompt.id,
      sdk: client,
      repoPath: '/r',
    })

    expect(typeof out.branchNodeId).toBe('string')
    expect(typeof out.promptNodeId).toBe('string')
    expect(typeof out.branchesContainerId).toBe('string')
    const promptNode = await store.getNode(out.promptNodeId)
    expect(promptNode!.parentId).toBe(out.branchNodeId)
    expect(promptNode!.content).toBe('')
  })

  it('throws on a Block-kind source (only Content / branches sources allowed)', async () => {
    const root = await store.createNode({
      parentId: null,
      content: 'r',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const prompt = await store.createNode({
      parentId: root.id,
      content: 'p',
      metadata: { state: 'done', sdkMessageUuid: 'm' },
    })
    const block = await store.createNode({
      parentId: prompt.id,
      kind: 'block',
      content: '',
      metadata: { role: 'block', payload: { kind: 'text', text: 'hi' } },
    })
    const { client } = fakeSdk()
    await expect(
      engine.forkAtPrompt({ sourceNodeId: block.id, sdk: client, repoPath: '/r' }),
    ).rejects.toThrow(/Block|content/i)
  })

  it('throws when the source has no bearer ancestor with a real sessionId (no fork base)', async () => {
    // bearer was stamped but never captured an sdkSessionId (still null).
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: null },
    })
    const prompt = await store.createNode({
      parentId: bearer.id,
      content: 'p',
      metadata: { state: 'streaming' },
    })
    const { client } = fakeSdk()
    await expect(
      engine.forkAtPrompt({ sourceNodeId: prompt.id, sdk: client, repoPath: '/r' }),
    ).rejects.toThrow(/session/i)
  })

  it('auto-names the Branch with a sequential placeholder (Branch 1, Branch 2, ...)', async () => {
    const bearer = await store.createNode({
      parentId: null,
      content: 'topic',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const prompt = await store.createNode({
      parentId: bearer.id,
      content: 'p',
      metadata: { state: 'done', sdkMessageUuid: 'm1' },
    })
    const { client } = fakeSdk({ forkedSessionId: 'sess-fork-x' })
    const first = await engine.forkAtPrompt({
      sourceNodeId: prompt.id,
      sdk: client,
      repoPath: '/r',
    })
    const firstBranch = await store.getNode(first.branchNodeId)
    expect(firstBranch!.content).toBe('Branch 1')

    // Re-fork — the second Branch lands in the SAME container.
    const second = await engine.forkAtPrompt({
      sourceNodeId: prompt.id,
      sdk: client,
      repoPath: '/r',
    })
    expect(second.branchesContainerId).toBe(first.branchesContainerId)
    const secondBranch = await store.getNode(second.branchNodeId)
    expect(secondBranch!.content).toBe('Branch 2')
  })
})
