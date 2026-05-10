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
  /** When non-null, only descendants of this Node are rendered (Workflowy zoom). */
  activeNodeId: string | null
  /** Workspace display name — first crumb in the breadcrumb chain. */
  workspaceName: string
  /** Called when the user changes the zoom target. `null` = workspace root. */
  onZoomTo: (nodeId: string | null) => void
  /**
   * Request to navigate to a node (e.g. from the search palette). The
   * `nonce` lets repeated requests for the same id re-trigger focus.
   */
  navigateRequest?: { id: string; nonce: number } | null
}

export function Tree({ workspaceId, activeNodeId, workspaceName, onZoomTo, navigateRequest }: Props) {
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

  // Ensure at least one node exists under the current zoom root so the user
  // has something to type into. When zoomed in, the zoom root itself is
  // hidden, so we seed an empty child of it.
  useEffect(() => {
    void (async () => {
      const children = byParent.get(activeNodeId)
      if (children && children.length === 0) {
        const created = await call('outline.create', {
          workspaceId,
          parentId: activeNodeId,
          content: '',
        })
        await load()
        setFocusId(created.id)
      }
    })()
  }, [byParent, workspaceId, load, activeNodeId])

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

  // Honour external navigation requests (search palette → jump to node).
  // Slice 1 has no collapse state, so "expand ancestors" is a no-op; we
  // focus the cell and scroll it into view. The nonce key ensures the
  // effect re-runs even when targeting the same id twice in a row.
  useEffect(() => {
    if (!navigateRequest) return
    const el = refs.current.get(navigateRequest.id)
    if (!el) return
    setFocusId(navigateRequest.id)
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [navigateRequest])

  const visible: Visible[] = useMemo(() => {
    const out: Visible[] = []
    function walk(parentId: string | null, depth: number) {
      const children = byParent.get(parentId) ?? []
      for (const c of children) {
        out.push({ node: c, depth })
        walk(c.id, depth + 1)
      }
    }
    // When zoomed in, render only descendants of activeNodeId; otherwise the
    // whole workspace tree (parentId === null roots).
    walk(activeNodeId, 0)
    return out
  }, [byParent, activeNodeId])

  const lookup = useMemo(() => {
    const map = new Map<string, Node>()
    for (const list of byParent.values()) for (const n of list) map.set(n.id, n)
    return map
  }, [byParent])

  /**
   * Path from the workspace root down to (and including) the currently zoomed
   * Node. Empty when we're at the workspace root view. The breadcrumb bar
   * always renders the workspace crumb plus this trail.
   */
  const ancestors: Node[] = useMemo(() => {
    if (!activeNodeId) return []
    const trail: Node[] = []
    let cursor: string | null = activeNodeId
    const seen = new Set<string>()
    while (cursor) {
      if (seen.has(cursor)) break
      seen.add(cursor)
      const n = lookup.get(cursor)
      if (!n) break
      trail.unshift(n)
      cursor = n.parentId
    }
    return trail
  }, [activeNodeId, lookup])

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

      if (intent.kind === 'zoom-in') {
        onZoomTo(intent.nodeId)
        return
      }
      if (intent.kind === 'zoom-out') {
        // One level out: walk to the parent of the current zoom root. If
        // there's no parent (already at the workspace root, or zoom root
        // is a top-level node), clear the zoom entirely.
        if (!activeNodeId) return
        const zoomRoot = lookup.get(activeNodeId)
        onZoomTo(zoomRoot?.parentId ?? null)
        return
      }
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
    [workspaceId, byParent, lookup, load, visible, activeNodeId, onZoomTo],
  )

  return (
    <div className="tree-wrap">
      <nav className="breadcrumbs" aria-label="zoom path">
        <button
          type="button"
          className="crumb crumb-root"
          onClick={() => onZoomTo(null)}
          disabled={activeNodeId === null}
        >
          {workspaceName}
        </button>
        {ancestors.map((n, i) => {
          const isLast = i === ancestors.length - 1
          return (
            <span key={n.id} className="crumb-sep-wrap">
              <span className="crumb-sep" aria-hidden="true">
                {' / '}
              </span>
              <button
                type="button"
                className={`crumb${isLast ? ' crumb-current' : ''}`}
                onClick={() => onZoomTo(n.id)}
                disabled={isLast}
              >
                {n.content.trim().length > 0 ? n.content : '(empty)'}
              </button>
            </span>
          )
        })}
      </nav>
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
    </div>
  )
}
