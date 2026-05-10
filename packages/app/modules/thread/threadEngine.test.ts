import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { createOutlineStore, type OutlineStore } from '../outline/outlineStore.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import { createThreadEngine, type ThreadEngine } from './threadEngine.ts'
import { BlockMetadataSchema, TurnMetadataSchema, type BlockPayload } from '../../src/contract.ts'

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

describe('threadEngine.startThread', () => {
  it('marks a Content Node as a Thread Root', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    const thread = await engine.startThread(root.id)
    expect(thread.id).toBe(root.id)
    expect(thread.kind).toBe('content')
    expect(thread.metadata).toMatchObject({ isThreadRoot: true })
    // And the persisted node sees the same.
    const fetched = await store.getNode(root.id)
    expect(fetched?.metadata).toMatchObject({ isThreadRoot: true })
  })

  it('rejects starting a Thread on a Turn Node', async () => {
    const turn = await store.createNode({ parentId: null, kind: 'turn', content: '' })
    await expect(engine.startThread(turn.id)).rejects.toThrow(/turn/i)
  })

  it('rejects starting a Thread on a Block Node', async () => {
    const block = await store.createNode({ parentId: null, kind: 'block', content: '' })
    await expect(engine.startThread(block.id)).rejects.toThrow(/block/i)
  })
})

describe('threadEngine.appendPrompt', () => {
  it('adds a Content Node child to the Thread Root with the given prompt', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const prompt = await engine.appendPrompt(root.id, 'what about X?')
    expect(prompt.kind).toBe('content')
    expect(prompt.parentId).toBe(root.id)
    expect(prompt.content).toBe('what about X?')

    const children = await store.getChildren(root.id)
    expect(children.map((c) => c.id)).toContain(prompt.id)
  })
})

describe('threadEngine.appendTurn', () => {
  it('adds a Turn Node child of the Thread Root with one Block Node per input block', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const result = await engine.appendTurn(root.id, [
      { kind: 'text', text: 'Looking…' },
      { kind: 'tool_use', toolName: 'Read', toolUseId: 'tu_1', input: { path: 'README.md' } },
      { kind: 'tool_result', toolUseId: 'tu_1', output: 'file contents' },
    ])

    expect(result.turn.kind).toBe('turn')
    expect(result.turn.parentId).toBe(root.id)
    expect(result.blocks).toHaveLength(3)
    for (const b of result.blocks) {
      expect(b.kind).toBe('block')
      expect(b.parentId).toBe(result.turn.id)
    }
    // The Turn is a child of the Thread Root.
    const rootChildren = await store.getChildren(root.id)
    expect(rootChildren.map((c) => c.id)).toContain(result.turn.id)
    // The Blocks are children of the Turn, in order.
    const turnChildren = await store.getChildren(result.turn.id)
    expect(turnChildren.map((c) => c.id)).toEqual(result.blocks.map((b) => b.id))
  })

  it('round-trips Turn and Block metadata through zod', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)
    const result = await engine.appendTurn(root.id, [
      { kind: 'text', text: 'hi' },
      { kind: 'tool_use', toolName: 'Grep', toolUseId: 'tu_a', input: { pattern: 'foo' } },
      { kind: 'tool_result', toolUseId: 'tu_a', output: ['hit1', 'hit2'] },
    ])

    const turnFetched = await store.getNode(result.turn.id)
    const turnMeta = TurnMetadataSchema.parse(turnFetched!.metadata)
    expect(turnMeta).toEqual({ role: 'turn', threadRootId: root.id })

    const block0 = await store.getNode(result.blocks[0]!.id)
    const block0Meta = BlockMetadataSchema.parse(block0!.metadata)
    expect(block0Meta.payload).toEqual({ kind: 'text', text: 'hi' })

    const block1 = await store.getNode(result.blocks[1]!.id)
    const block1Meta = BlockMetadataSchema.parse(block1!.metadata)
    expect(block1Meta.payload).toMatchObject({
      kind: 'tool_use',
      toolName: 'Grep',
      toolUseId: 'tu_a',
    })

    const block2 = await store.getNode(result.blocks[2]!.id)
    const block2Meta = BlockMetadataSchema.parse(block2!.metadata)
    expect(block2Meta.payload).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_a',
    })
  })
})

describe('threadEngine streaming verbs (slice 4 lifecycle)', () => {
  it('beginTurn stamps state=streaming on the new Turn', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)
    const turn = await engine.beginTurn(root.id)
    const meta = TurnMetadataSchema.parse(turn.metadata)
    expect(meta.state).toBe('streaming')
    expect(meta.role).toBe('turn')
    expect(meta.threadRootId).toBe(root.id)
  })

  it('markTurnDone transitions streaming → done', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)
    const turn = await engine.beginTurn(root.id)
    const updated = await engine.markTurnDone(turn.id)
    const meta = TurnMetadataSchema.parse(updated.metadata)
    expect(meta.state).toBe('done')
  })

  it('markTurnCancelled transitions streaming → cancelled (and keeps legacy flag)', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)
    const turn = await engine.beginTurn(root.id)
    const updated = await engine.markTurnCancelled(turn.id)
    const meta = TurnMetadataSchema.parse(updated.metadata)
    expect(meta.state).toBe('cancelled')
    // Back-compat with slice 3 readers that look at the boolean.
    expect(meta.cancelled).toBe(true)
  })

  it('markTurnInterrupted transitions streaming → interrupted', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)
    const turn = await engine.beginTurn(root.id)
    const updated = await engine.markTurnInterrupted(turn.id)
    const meta = TurnMetadataSchema.parse(updated.metadata)
    expect(meta.state).toBe('interrupted')
  })
})

// -----------------------------------------------------------------------
// Slice 5: branch verb
//
// `branch(sourceBlockId)` produces a new sibling Thread under the same
// Thread Root. The new Thread is itself a Content Node with
// `isThreadRoot: true` (so send-prompt routes correctly) and
// `branchedFromBlockId: <sourceBlockId>` so the UI can show a fork badge.
// Its children mirror the conversation history through the source Block:
// for each turn in the original Thread Root up to (and including) the
// source Turn, clone the preceding human prompt (if any) and the Turn
// Node with its Block children — but the source Turn only carries Block
// children up to and including the source Block. After history is
// cloned, an empty Content Node is appended as the next prompt slot
// (the renderer focuses it after the IPC).
// -----------------------------------------------------------------------

/**
 * Build a Thread Root with a fixed history shape used across the branch
 * tests. Returns ids of every node we'll branch from.
 *
 *   threadRoot
 *     prompt1          (content "hello")
 *     turn1            (3 blocks: text, tool_use, tool_result)
 *     prompt2          (content "follow up")
 *     turn2            (2 blocks: text, text)
 */
async function seedThread(s: OutlineStore, e: ThreadEngine) {
  const root = await s.createNode({ parentId: null, content: 'topic' })
  await e.startThread(root.id)
  const prompt1 = await e.appendPrompt(root.id, 'hello')
  const turn1Blocks: BlockPayload[] = [
    { kind: 'text', text: 'thinking…' },
    { kind: 'tool_use', toolName: 'Read', toolUseId: 'tu_1', input: { path: 'a.md' } },
    { kind: 'tool_result', toolUseId: 'tu_1', output: 'contents of a' },
  ]
  const t1 = await e.appendTurn(root.id, turn1Blocks)
  const prompt2 = await e.appendPrompt(root.id, 'follow up')
  const turn2Blocks: BlockPayload[] = [
    { kind: 'text', text: 'first paragraph' },
    { kind: 'text', text: 'second paragraph' },
  ]
  const t2 = await e.appendTurn(root.id, turn2Blocks)
  return {
    rootId: root.id,
    prompt1Id: prompt1.id,
    turn1Id: t1.turn.id,
    turn1BlockIds: t1.blocks.map((b) => b.id),
    prompt2Id: prompt2.id,
    turn2Id: t2.turn.id,
    turn2BlockIds: t2.blocks.map((b) => b.id),
  }
}

describe('threadEngine.branch', () => {
  it('returns a new Thread Root with a promptNode and isThreadRoot+branchedFromBlockId metadata', async () => {
    const root = await store.createNode({ parentId: null, content: 'topic' })
    await engine.startThread(root.id)
    await engine.appendPrompt(root.id, 'hi')
    const t = await engine.appendTurn(root.id, [{ kind: 'text', text: 'hello' }])
    const sourceBlockId = t.blocks[0]!.id

    const result = await engine.branch(sourceBlockId)
    expect(result.newThreadId).toBeTypeOf('string')
    expect(result.promptNodeId).toBeTypeOf('string')

    const newThread = await store.getNode(result.newThreadId)
    expect(newThread).not.toBeNull()
    expect(newThread!.kind).toBe('content')
    expect(newThread!.parentId).toBe(root.id)
    expect(newThread!.metadata).toMatchObject({
      isThreadRoot: true,
      branchedFromBlockId: sourceBlockId,
    })

    // Prompt slot is empty and is a Content Node child of the new Thread.
    const promptNode = await store.getNode(result.promptNodeId)
    expect(promptNode).not.toBeNull()
    expect(promptNode!.kind).toBe('content')
    expect(promptNode!.content).toBe('')
    expect(promptNode!.parentId).toBe(result.newThreadId)
  })

  it('clones history through the source Block when branching from the first Block of the first Turn', async () => {
    const seed = await seedThread(store, engine)
    // First Block of Turn 1 → history slice = [prompt1, turn1 (only block 0)].
    const result = await engine.branch(seed.turn1BlockIds[0]!)

    const newThreadChildren = await store.getChildren(result.newThreadId)
    // Expect exactly: [cloned prompt1, cloned turn1, empty prompt slot]
    expect(newThreadChildren).toHaveLength(3)
    expect(newThreadChildren[0]!.kind).toBe('content')
    expect(newThreadChildren[0]!.content).toBe('hello')
    expect(newThreadChildren[1]!.kind).toBe('turn')
    expect(newThreadChildren[2]!.id).toBe(result.promptNodeId)
    expect(newThreadChildren[2]!.content).toBe('')

    // The cloned turn carries only the first block.
    const clonedTurnBlocks = await store.getChildren(newThreadChildren[1]!.id)
    expect(clonedTurnBlocks).toHaveLength(1)
    const meta = BlockMetadataSchema.parse(clonedTurnBlocks[0]!.metadata)
    expect(meta.payload).toEqual({ kind: 'text', text: 'thinking…' })
    // And the cloned turn's threadRootId points to the *new* Thread Root.
    const turnMeta = TurnMetadataSchema.parse(newThreadChildren[1]!.metadata)
    expect(turnMeta.threadRootId).toBe(result.newThreadId)
    expect(turnMeta.state).toBe('done')
  })

  it('clones history through a middle Block of Turn 1 (a tool_use)', async () => {
    const seed = await seedThread(store, engine)
    const sourceBlockId = seed.turn1BlockIds[1]! // tool_use
    const result = await engine.branch(sourceBlockId)

    const newThreadChildren = await store.getChildren(result.newThreadId)
    expect(newThreadChildren).toHaveLength(3)
    const clonedTurnBlocks = await store.getChildren(newThreadChildren[1]!.id)
    expect(clonedTurnBlocks).toHaveLength(2)
    const m0 = BlockMetadataSchema.parse(clonedTurnBlocks[0]!.metadata)
    expect(m0.payload).toMatchObject({ kind: 'text' })
    const m1 = BlockMetadataSchema.parse(clonedTurnBlocks[1]!.metadata)
    expect(m1.payload).toMatchObject({ kind: 'tool_use', toolName: 'Read' })
  })

  it('clones history through a tool_result Block', async () => {
    const seed = await seedThread(store, engine)
    const sourceBlockId = seed.turn1BlockIds[2]! // tool_result
    const result = await engine.branch(sourceBlockId)

    const newThreadChildren = await store.getChildren(result.newThreadId)
    // [prompt1, turn1 (full), empty prompt]
    expect(newThreadChildren).toHaveLength(3)
    const clonedTurnBlocks = await store.getChildren(newThreadChildren[1]!.id)
    expect(clonedTurnBlocks).toHaveLength(3)
    const last = BlockMetadataSchema.parse(clonedTurnBlocks[2]!.metadata)
    expect(last.payload).toMatchObject({ kind: 'tool_result' })
  })

  it('clones full prior turns + partial source turn when branching from the last Block of the last Turn', async () => {
    const seed = await seedThread(store, engine)
    const sourceBlockId = seed.turn2BlockIds[1]! // last block of turn 2
    const result = await engine.branch(sourceBlockId)

    const newThreadChildren = await store.getChildren(result.newThreadId)
    // [prompt1, turn1 (full 3 blocks), prompt2, turn2 (full 2 blocks), empty prompt]
    expect(newThreadChildren).toHaveLength(5)
    expect(newThreadChildren[0]!.content).toBe('hello')
    expect(newThreadChildren[1]!.kind).toBe('turn')
    expect(newThreadChildren[2]!.content).toBe('follow up')
    expect(newThreadChildren[3]!.kind).toBe('turn')
    expect(newThreadChildren[4]!.id).toBe(result.promptNodeId)
    expect(newThreadChildren[4]!.content).toBe('')

    const t1Blocks = await store.getChildren(newThreadChildren[1]!.id)
    expect(t1Blocks).toHaveLength(3)
    const t2Blocks = await store.getChildren(newThreadChildren[3]!.id)
    expect(t2Blocks).toHaveLength(2)
  })

  it('places the new Thread as a child of the original Thread Root, alongside existing prompts/turns', async () => {
    const seed = await seedThread(store, engine)
    const result = await engine.branch(seed.turn1BlockIds[0]!)
    const newThread = await store.getNode(result.newThreadId)
    // The sibling Thread lives UNDER the original Thread Root — that's
    // what makes it a sibling of the existing Thread (the existing
    // prompt/turn children).
    expect(newThread!.parentId).toBe(seed.rootId)
    // And it's the last child of the original Thread Root, so the user
    // sees the fork appear after the prior conversation.
    const rootChildren = await store.getChildren(seed.rootId)
    expect(rootChildren[rootChildren.length - 1]!.id).toBe(result.newThreadId)
  })

  it('supports multiple sibling branches from the same Thread Root', async () => {
    const seed = await seedThread(store, engine)
    const b1 = await engine.branch(seed.turn1BlockIds[0]!)
    const b2 = await engine.branch(seed.turn2BlockIds[0]!)

    const t1 = await store.getNode(b1.newThreadId)
    const t2 = await store.getNode(b2.newThreadId)
    // Both new Threads live under the original Thread Root.
    expect(t1!.parentId).toBe(seed.rootId)
    expect(t2!.parentId).toBe(seed.rootId)
    expect(t1!.id).not.toBe(t2!.id)

    // Both are stamped as Thread Roots with the right source block.
    expect((t1!.metadata as { branchedFromBlockId?: string }).branchedFromBlockId).toBe(
      seed.turn1BlockIds[0]!,
    )
    expect((t2!.metadata as { branchedFromBlockId?: string }).branchedFromBlockId).toBe(
      seed.turn2BlockIds[0]!,
    )

    // Both appear as direct children of the original Thread Root (ordered
    // after the original prompts/turns so the visible top-down order is
    // [original conversation, branch 1, branch 2]).
    const rootChildren = await store.getChildren(seed.rootId)
    const ids = rootChildren.map((c) => c.id)
    expect(ids).toContain(b1.newThreadId)
    expect(ids).toContain(b2.newThreadId)
    expect(ids.indexOf(b1.newThreadId)).toBeLessThan(ids.indexOf(b2.newThreadId))
  })

  it('rejects branching from a non-Block Node', async () => {
    const seed = await seedThread(store, engine)
    await expect(engine.branch(seed.turn1Id)).rejects.toThrow(/block/i)
  })

  it('rejects branching from an unknown id', async () => {
    await expect(engine.branch('does-not-exist')).rejects.toThrow(/not found/i)
  })
})
