/**
 * Unit tests for crash-recovery scan (slice 4).
 *
 * On app launch the renderer asks the sidecar to find any Turn Nodes left
 * in `state: 'streaming'` — these are necessarily orphaned because the
 * sidecar process is fresh and no runner can be driving them. The scan
 * stamps them `state: 'interrupted'` so the user can tell partial output
 * from a crashed turn apart from a deliberately-cancelled one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from '../outline/migrations.ts'
import { createOutlineStore, type OutlineStore } from '../outline/outlineStore.ts'
import { createThreadEngine, type ThreadEngine } from './threadEngine.ts'
import { scanInterruptedTurns } from './crashRecovery.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'
import { TurnMetadataSchema } from '../../src/contract.ts'

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

describe('scanInterruptedTurns', () => {
  it('marks streaming turns as interrupted', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const streaming = await engine.beginTurn(root.id)
    // Sanity check: beginTurn stamps state=streaming.
    const streamingMeta = TurnMetadataSchema.parse(streaming.metadata)
    expect(streamingMeta.state).toBe('streaming')

    const result = await scanInterruptedTurns(store)
    expect(result.interruptedTurnIds).toEqual([streaming.id])

    const after = await store.getNode(streaming.id)
    const afterMeta = TurnMetadataSchema.parse(after!.metadata)
    expect(afterMeta.state).toBe('interrupted')
  })

  it('does not touch turns that are done, cancelled, or already interrupted', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)

    const t1 = await engine.beginTurn(root.id)
    await engine.markTurnDone(t1.id)
    const t2 = await engine.beginTurn(root.id)
    await engine.markTurnCancelled(t2.id)
    const t3 = await engine.beginTurn(root.id)
    await engine.markTurnInterrupted(t3.id)

    const result = await scanInterruptedTurns(store)
    expect(result.interruptedTurnIds).toEqual([])

    // Verify states unchanged.
    const m1 = TurnMetadataSchema.parse((await store.getNode(t1.id))!.metadata)
    const m2 = TurnMetadataSchema.parse((await store.getNode(t2.id))!.metadata)
    const m3 = TurnMetadataSchema.parse((await store.getNode(t3.id))!.metadata)
    expect(m1.state).toBe('done')
    expect(m2.state).toBe('cancelled')
    expect(m3.state).toBe('interrupted')
  })

  it('finds streaming turns in any thread / nesting level', async () => {
    const a = await store.createNode({ parentId: null, content: 'a' })
    const b = await store.createNode({ parentId: null, content: 'b' })
    await engine.startThread(a.id)
    await engine.startThread(b.id)
    const ta = await engine.beginTurn(a.id)
    const tb = await engine.beginTurn(b.id)

    const result = await scanInterruptedTurns(store)
    expect(new Set(result.interruptedTurnIds)).toEqual(new Set([ta.id, tb.id]))
  })

  it('returns empty when there are no streaming turns', async () => {
    const root = await store.createNode({ parentId: null, content: 'idea' })
    await engine.startThread(root.id)
    // Append a fixture (one-shot) Turn — its metadata has no `state` field;
    // it must NOT be re-classified as interrupted.
    await engine.appendTurn(root.id, [{ kind: 'text', text: 'hi' }])

    const result = await scanInterruptedTurns(store)
    expect(result.interruptedTurnIds).toEqual([])
  })
})
