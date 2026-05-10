import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../ipc'
import type { Node } from '../contract'
import { interpret } from '../keymap'

interface Visible {
  node: Node
  depth: number
}

interface Props {
  workspaceId: string
}

export function Tree({ workspaceId }: Props) {
  const [byParent, setByParent] = useState<Map<string | null, Node[]>>(new Map())
  const [focusId, setFocusId] = useState<string | null>(null)
  const refs = useRef(new Map<string, HTMLDivElement>())

  const load = useCallback(async () => {
    // Load all nodes by walking from roots. Slice 1: simple, no virtualization.
    const acc = new Map<string | null, Node[]>()
    const queue: (string | null)[] = [null]
    while (queue.length) {
      const parent = queue.shift()!
      const children = await call('outline.getChildren', { workspaceId, parentId: parent })
      acc.set(parent, children)
      for (const c of children) queue.push(c.id)
    }
    setByParent(acc)
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  // Ensure at least one node exists so user has something to type into.
  useEffect(() => {
    void (async () => {
      const roots = byParent.get(null)
      if (roots && roots.length === 0) {
        const created = await call('outline.create', { workspaceId, parentId: null, content: '' })
        await load()
        setFocusId(created.id)
      }
    })()
  }, [byParent, workspaceId, load])

  useEffect(() => {
    if (!focusId) return
    const el = refs.current.get(focusId)
    if (el) {
      el.focus()
      // Move caret to end
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [focusId])

  const visible: Visible[] = useMemo(() => {
    const out: Visible[] = []
    function walk(parentId: string | null, depth: number) {
      const children = byParent.get(parentId) ?? []
      for (const c of children) {
        out.push({ node: c, depth })
        walk(c.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [byParent])

  const lookup = useMemo(() => {
    const map = new Map<string, Node>()
    for (const list of byParent.values()) for (const n of list) map.set(n.id, n)
    return map
  }, [byParent])

  const handleInput = useCallback(
    (id: string, content: string) => {
      // Fire-and-forget; debounce later if needed.
      void call('outline.update', { workspaceId, id, content })
    },
    [workspaceId],
  )

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLDivElement>, n: Node) => {
      const parent = n.parentId ? lookup.get(n.parentId) ?? null : null
      const siblings = byParent.get(n.parentId) ?? []
      const idx = siblings.findIndex((s) => s.id === n.id)
      const prevSibling = idx > 0 ? siblings[idx - 1]! : null
      const prevSiblingChildren = prevSibling ? byParent.get(prevSibling.id) ?? [] : []
      const prevSiblingLastChildId = prevSiblingChildren.length
        ? prevSiblingChildren[prevSiblingChildren.length - 1]!.id
        : null

      const el = e.currentTarget
      const isContentEmpty = (el.textContent ?? '').trim().length === 0

      const intent = interpret(
        { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
        { node: n, parent, prevSibling, prevSiblingLastChildId, isContentEmpty },
      )

      if (intent.kind === 'noop') return
      e.preventDefault()

      if (intent.kind === 'create-sibling') {
        const created = await call('outline.create', {
          workspaceId,
          parentId: intent.parentId,
          prevSiblingId: intent.afterId,
          content: '',
        })
        await load()
        setFocusId(created.id)
        return
      }
      if (intent.kind === 'nest') {
        await call('outline.move', {
          workspaceId,
          id: intent.nodeId,
          newParentId: intent.newParentId,
          prevSiblingId: intent.prevSiblingId,
        })
        await load()
        setFocusId(intent.nodeId)
        return
      }
      if (intent.kind === 'outdent') {
        await call('outline.move', {
          workspaceId,
          id: intent.nodeId,
          newParentId: intent.newParentId,
          prevSiblingId: intent.prevSiblingId,
        })
        await load()
        setFocusId(intent.nodeId)
        return
      }
      if (intent.kind === 'delete-empty') {
        // Find prev visible to focus
        const flat = visible
        const myIdx = flat.findIndex((v) => v.node.id === intent.nodeId)
        const prev = myIdx > 0 ? flat[myIdx - 1] : null
        await call('outline.delete', { workspaceId, id: intent.nodeId })
        await load()
        if (prev) setFocusId(prev.node.id)
        return
      }
    },
    [workspaceId, byParent, lookup, load, visible],
  )

  return (
    <div className="tree">
      {visible.map(({ node, depth }) => (
        <div key={node.id} className="tree-node" style={{ paddingLeft: depth * 18 }}>
          <span className="bullet">·</span>
          <div
            ref={(el) => {
              if (el) refs.current.set(node.id, el)
              else refs.current.delete(node.id)
            }}
            className="content"
            contentEditable
            suppressContentEditableWarning
            onInput={(e) => handleInput(node.id, e.currentTarget.textContent ?? '')}
            onKeyDown={(e) => void handleKeyDown(e, node)}
          >
            {node.content}
          </div>
        </div>
      ))}
    </div>
  )
}
