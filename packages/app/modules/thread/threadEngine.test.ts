import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { createOutlineStore, type OutlineStore } from '../outline/outlineStore.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import { createThreadEngine, type ThreadEngine } from './threadEngine.ts'
import { BlockMetadataSchema, TurnMetadataSchema } from '../../src/contract.ts'

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
