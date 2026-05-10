/**
 * Unit tests for crash-recovery scan (v1.1 Shape B).
 *
 * On app launch the renderer asks the sidecar to find any Prompt
 * Content Nodes left in `metadata.state: 'streaming'` — these are
 * necessarily orphaned because the sidecar process is fresh and no
 * runner can be driving them. The scan stamps them
 * `state: 'interrupted'` so the user can tell partial output from a
 * crashed run apart from a deliberately-cancelled one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { createOutlineStore, type OutlineStore } from '../outline/outlineStore.ts'
import { createThreadEngine, type ThreadEngine } from './threadEngine.ts'
import { scanInterruptedPrompts } from './crashRecovery.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import { PromptMetadataSchema } from '../../src/contract.ts'

let store: OutlineStore
let engine: ThreadEngine
let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempWorktreeScoped('crash-recovery-')
  const db = createClient({ url: `file:${join(tmpDir, 'test.db')}` })
  await runMigrations(db)
  store = createOutlineStore(db)
  engine = createThreadEngine(store)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function makeStreamingPrompt(parentId: string | null): Promise<string> {
  // Simulate what `sendPrompt` would have written before a crash:
  // a Content Node Prompt under a session-bearer parent, stamped
  // `state: 'streaming'`.
  const node = await store.createNode({
    parentId,
    kind: 'content',
    content: 'hi',
    metadata: { state: 'streaming' },
  })
  return node.id
}

describe('scanInterruptedPrompts', () => {
  it('marks streaming prompts as interrupted', async () => {
    const root = await store.createNode({
      parentId: null,
      content: 'idea',
      metadata: { sdkSessionId: 'sess-1' },
    })
    const promptId = await makeStreamingPrompt(root.id)

    const result = await scanInterruptedPrompts(store)
    expect(result.interruptedPromptIds).toEqual([promptId])

    const after = await store.getNode(promptId)
    expect(PromptMetadataSchema.parse(after!.metadata).state).toBe('interrupted')
  })

  it('does not touch prompts that are done, cancelled, or already interrupted', async () => {
    const root = await store.createNode({
      parentId: null,
      content: 'idea',
      metadata: { sdkSessionId: 'sess-1' },
    })
    const p1 = await makeStreamingPrompt(root.id)
    await engine.markPromptDone(p1)
    const p2 = await makeStreamingPrompt(root.id)
    await engine.markPromptCancelled(p2)
    const p3 = await makeStreamingPrompt(root.id)
    await engine.markPromptInterrupted(p3)

    const result = await scanInterruptedPrompts(store)
    expect(result.interruptedPromptIds).toEqual([])

    expect(PromptMetadataSchema.parse((await store.getNode(p1))!.metadata).state).toBe('done')
    expect(PromptMetadataSchema.parse((await store.getNode(p2))!.metadata).state).toBe('cancelled')
    expect(PromptMetadataSchema.parse((await store.getNode(p3))!.metadata).state).toBe(
      'interrupted',
    )
  })

  it('finds streaming prompts in any nesting level', async () => {
    const a = await store.createNode({
      parentId: null,
      content: 'a',
      metadata: { sdkSessionId: 'sess-a' },
    })
    const b = await store.createNode({
      parentId: null,
      content: 'b',
      metadata: { sdkSessionId: 'sess-b' },
    })
    const pa = await makeStreamingPrompt(a.id)
    const pb = await makeStreamingPrompt(b.id)

    const result = await scanInterruptedPrompts(store)
    expect(new Set(result.interruptedPromptIds)).toEqual(new Set([pa, pb]))
  })

  it('returns empty when there are no streaming prompts', async () => {
    const root = await store.createNode({
      parentId: null,
      content: 'idea',
      metadata: { sdkSessionId: 'sess-1' },
    })
    // A plain Content Node draft (no `state` field) must NOT be
    // re-classified as interrupted.
    await store.createNode({ parentId: root.id, content: 'draft' })

    const result = await scanInterruptedPrompts(store)
    expect(result.interruptedPromptIds).toEqual([])
  })

  it('idempotent on a second run', async () => {
    const root = await store.createNode({
      parentId: null,
      content: 'idea',
      metadata: { sdkSessionId: 'sess-1' },
    })
    await makeStreamingPrompt(root.id)
    const first = await scanInterruptedPrompts(store)
    expect(first.interruptedPromptIds).toHaveLength(1)
    const second = await scanInterruptedPrompts(store)
    expect(second.interruptedPromptIds).toEqual([])
  })
})
