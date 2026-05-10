import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '../db/libsqlClient.ts'
import { runMigrations } from './migrations.ts'
import { createOutlineStore, type OutlineStore } from './outlineStore.ts'
import { mkdtempWorktreeScoped } from '../test-utils/worktreeTmp.ts'

let store: OutlineStore
let tmpDir: string

beforeEach(async () => {
  // libSQL `:memory:` is per-connection — transactions open new connections,
  // so use a worktree-scoped temp file instead.
  tmpDir = await mkdtempWorktreeScoped('outline-store-')
  const db = createClient({ url: `file:${join(tmpDir, 'test.db')}` })
  await runMigrations(db)
  store = createOutlineStore(db)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('outlineStore', () => {
  it('round-trips a root content node', async () => {
    const node = await store.createNode({ parentId: null, content: 'hello' })
    const fetched = await store.getNode(node.id)
    expect(fetched).toEqual(node)
  })

  it('getChildren(null) returns roots in position order', async () => {
    const a = await store.createNode({ parentId: null, content: 'A' })
    const b = await store.createNode({ parentId: null, prevSiblingId: a.id, content: 'B' })
    const c = await store.createNode({ parentId: null, prevSiblingId: b.id, content: 'C' })
    const roots = await store.getChildren(null)
    expect(roots.map((n) => n.id)).toEqual([a.id, b.id, c.id])
  })

  it('createNode with prevSiblingId places new node after that sibling', async () => {
    const a = await store.createNode({ parentId: null, content: 'A' })
    const c = await store.createNode({ parentId: null, prevSiblingId: a.id, content: 'C' })
    const b = await store.createNode({ parentId: null, prevSiblingId: a.id, content: 'B' })
    const roots = await store.getChildren(null)
    // a < b < c by position because b was inserted after a, before c
    expect(roots.map((n) => n.id)).toEqual([a.id, b.id, c.id])
  })

  it('updateNode persists content and bumps updated_at', async () => {
    const node = await store.createNode({ parentId: null, content: 'old' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await store.updateNode({ id: node.id, content: 'new' })
    expect(updated.content).toBe('new')
    expect(updated.updatedAt).toBeGreaterThan(node.updatedAt)
    const fetched = await store.getNode(node.id)
    expect(fetched?.content).toBe('new')
  })

  it('deleteNode cascades to descendants', async () => {
    const a = await store.createNode({ parentId: null, content: 'A' })
    const b = await store.createNode({ parentId: a.id, content: 'A.1' })
    const c = await store.createNode({ parentId: b.id, content: 'A.1.1' })
    const out = await store.deleteNode(a.id)
    expect(out.deleted).toBeGreaterThanOrEqual(1)
    expect(await store.getNode(a.id)).toBeNull()
    expect(await store.getNode(b.id)).toBeNull()
    expect(await store.getNode(c.id)).toBeNull()
  })

  it('moveNode atomically updates parent and position', async () => {
    const a = await store.createNode({ parentId: null, content: 'A' })
    const b = await store.createNode({ parentId: null, prevSiblingId: a.id, content: 'B' })
    const c = await store.createNode({ parentId: null, prevSiblingId: b.id, content: 'C' })
    // Move B under A
    const moved = await store.moveNode({ id: b.id, newParentId: a.id, prevSiblingId: null })
    expect(moved.parentId).toBe(a.id)
    const aChildren = await store.getChildren(a.id)
    expect(aChildren.map((n) => n.id)).toEqual([b.id])
    const roots = await store.getChildren(null)
    expect(roots.map((n) => n.id)).toEqual([a.id, c.id])
  })

  it('moveNode rejects creating a cycle', async () => {
    const a = await store.createNode({ parentId: null, content: 'A' })
    const b = await store.createNode({ parentId: a.id, content: 'A.1' })
    const c = await store.createNode({ parentId: b.id, content: 'A.1.1' })
    // Trying to move A under C (its own descendant) must throw
    await expect(store.moveNode({ id: a.id, newParentId: c.id, prevSiblingId: null })).rejects.toThrow()
    // Self-move also rejected
    await expect(store.moveNode({ id: a.id, newParentId: a.id, prevSiblingId: null })).rejects.toThrow()
  })

  it('searchNodes returns matches via FTS', async () => {
    await store.createNode({ parentId: null, content: 'hello world' })
    await store.createNode({ parentId: null, content: 'goodbye sky' })
    const hits = await store.searchNodes('hello')
    expect(hits.length).toBe(1)
    expect(hits[0]?.content).toBe('hello world')
  })

  it('searchNodes handles multi-term queries and returns no rows on miss', async () => {
    await store.createNode({ parentId: null, content: 'red apple pie' })
    await store.createNode({ parentId: null, content: 'green apple jam' })
    await store.createNode({ parentId: null, content: 'banana split' })
    // Multi-term implicit AND (FTS5 default)
    const both = await store.searchNodes('red apple')
    expect(both.map((n) => n.content)).toEqual(['red apple pie'])
    // No matches
    const none = await store.searchNodes('zzznotpresent')
    expect(none).toEqual([])
  })

  it('searchNodes finds matches anywhere in the tree (across depths/parents)', async () => {
    // Slice 1 only models 'content' Node kind, but searchNodes must work
    // regardless of where in the tree the node lives — root and descendants
    // alike. (Once Turn/Block kinds land in slice 3+ the same code path
    // covers them.)
    const root = await store.createNode({ parentId: null, content: 'project alpha' })
    const child = await store.createNode({ parentId: root.id, content: 'subtask alpha' })
    const grand = await store.createNode({ parentId: child.id, content: 'leaf alpha' })
    const hits = await store.searchNodes('alpha')
    const ids = new Set(hits.map((n) => n.id))
    expect(ids.has(root.id)).toBe(true)
    expect(ids.has(child.id)).toBe(true)
    expect(ids.has(grand.id)).toBe(true)
  })

  it('50 sequential inserts at same parent keep positions unique and sorted', async () => {
    const ids: string[] = []
    let prev: string | null = null
    for (let i = 0; i < 50; i++) {
      const n = await store.createNode({ parentId: null, prevSiblingId: prev, content: `n${i}` })
      ids.push(n.id)
      prev = n.id
    }
    const roots = await store.getChildren(null)
    expect(roots.map((n) => n.id)).toEqual(ids)
    const positions = roots.map((n) => n.position)
    expect(new Set(positions).size).toBe(50)
    expect([...positions].sort()).toEqual(positions)
  })

  it('round-trips arbitrary metadata through the JSON column', async () => {
    const meta = { color: 'red', tags: ['x', 'y'], n: 42 }
    const node = await store.createNode({ parentId: null, content: 'm', metadata: meta })
    const fetched = await store.getNode(node.id)
    expect(fetched?.metadata).toEqual(meta)
    const updated = await store.updateNode({ id: node.id, metadata: { color: 'blue' } })
    expect(updated.metadata).toEqual({ color: 'blue' })
  })

  it('updateNode toggles completed and persists across reads', async () => {
    const node = await store.createNode({ parentId: null, content: 'task' })
    expect(node.completed).toBe(false)
    const done = await store.updateNode({ id: node.id, completed: true })
    expect(done.completed).toBe(true)
    const refetch = await store.getNode(node.id)
    expect(refetch?.completed).toBe(true)
    const undone = await store.updateNode({ id: node.id, completed: false })
    expect(undone.completed).toBe(false)
    const refetch2 = await store.getNode(node.id)
    expect(refetch2?.completed).toBe(false)
  })

  it('moveNode across parents preserves descendants and reorders correctly', async () => {
    // Build:
    //   A
    //     A.1
    //       A.1.1
    //   B
    //     B.1
    const a = await store.createNode({ parentId: null, content: 'A' })
    const a1 = await store.createNode({ parentId: a.id, content: 'A.1' })
    const a11 = await store.createNode({ parentId: a1.id, content: 'A.1.1' })
    const b = await store.createNode({ parentId: null, prevSiblingId: a.id, content: 'B' })
    const b1 = await store.createNode({ parentId: b.id, content: 'B.1' })

    // Move A.1 (with its descendant A.1.1) under B, after B.1.
    const moved = await store.moveNode({ id: a1.id, newParentId: b.id, prevSiblingId: b1.id })
    expect(moved.parentId).toBe(b.id)

    // A now has no children.
    const aChildren = await store.getChildren(a.id)
    expect(aChildren.map((n) => n.id)).toEqual([])

    // B now has [B.1, A.1] in that order.
    const bChildren = await store.getChildren(b.id)
    expect(bChildren.map((n) => n.id)).toEqual([b1.id, a1.id])

    // A.1.1 is still a child of A.1 (descendants travel with the moved node).
    const a1Children = await store.getChildren(a1.id)
    expect(a1Children.map((n) => n.id)).toEqual([a11.id])
    const a11Fetched = await store.getNode(a11.id)
    expect(a11Fetched?.parentId).toBe(a1.id)
  })

  it('CRUDs all three kinds (content, turn, block) without CHECK violations', async () => {
    const c = await store.createNode({ parentId: null, kind: 'content', content: 'c' })
    const t = await store.createNode({ parentId: c.id, kind: 'turn', content: '' })
    const b = await store.createNode({ parentId: t.id, kind: 'block', content: 'hello' })

    expect((await store.getNode(c.id))?.kind).toBe('content')
    expect((await store.getNode(t.id))?.kind).toBe('turn')
    expect((await store.getNode(b.id))?.kind).toBe('block')

    // getChildren preserves kinds
    const tChildren = await store.getChildren(t.id)
    expect(tChildren).toHaveLength(1)
    expect(tChildren[0]!.kind).toBe('block')

    // delete cascades across kinds
    await store.deleteNode(c.id)
    expect(await store.getNode(t.id)).toBeNull()
    expect(await store.getNode(b.id)).toBeNull()
  })
})
