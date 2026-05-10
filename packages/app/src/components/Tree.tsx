import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, streamSendPrompt } from '../ipc'
import type { BlockMetadata, Node, RunnerEvent } from '../contract'
import { BlockMetadataSchema } from '../contract'
import { interpret } from '../keymap'

interface Visible {
  node: Node
  depth: number
}

interface Props {
  workspaceId: string
  hideCompleted: boolean
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

/**
 * Drop target for a drag operation. We only support sibling-position drops:
 * the dragged node lands as a sibling of `targetId` (or first child of
 * `parentId` when `targetId` is null), under the indicated parent.
 *
 * Special case: dropping over a node with `position: 'inside'` nests the
 * dragged node as the FIRST child of that target. This gives a single-DOM
 * coverage of "drop into" without needing a separate visual zone.
 */
type DropPos =
  | { kind: 'before'; targetId: string; parentId: string | null }
  | { kind: 'after'; targetId: string; parentId: string | null }
  | { kind: 'inside'; targetId: string }

/**
 * Visual classification of a Node for rendering. Slice 2 distinguishes:
 *   - 'content'     — default outline node
 *   - 'thread-root' — Content Node promoted via thread.start
 *   - 'turn'        — Turn Node (one Claude turn)
 *   - 'block-text'  — Block Node carrying a `text` payload
 *   - 'block-tool-use'    — Block Node carrying a `tool_use` payload
 *   - 'block-tool-result' — Block Node carrying a `tool_result` payload
 */
type Visual =
  | 'content'
  | 'thread-root'
  | 'turn'
  | 'block-text'
  | 'block-tool-use'
  | 'block-tool-result'

function classifyNode(n: Node): { visual: Visual; blockMeta?: BlockMetadata } {
  if (n.kind === 'turn') return { visual: 'turn' }
  if (n.kind === 'block') {
    const parsed = BlockMetadataSchema.safeParse(n.metadata)
    if (parsed.success) {
      const k = parsed.data.payload.kind
      if (k === 'text') return { visual: 'block-text', blockMeta: parsed.data }
      if (k === 'tool_use') return { visual: 'block-tool-use', blockMeta: parsed.data }
      if (k === 'tool_result') return { visual: 'block-tool-result', blockMeta: parsed.data }
    }
    return { visual: 'block-text' }
  }
  if (n.metadata && (n.metadata as { isThreadRoot?: unknown }).isThreadRoot === true) {
    return { visual: 'thread-root' }
  }
  return { visual: 'content' }
}

function bulletForVisual(v: Visual): string {
  switch (v) {
    case 'thread-root':
      return '>'
    case 'turn':
      return '~'
    case 'block-text':
      return '·'
    case 'block-tool-use':
      return '⚙'
    case 'block-tool-result':
      return '↳'
    default:
      return '·'
  }
}

export function Tree({
  workspaceId,
  hideCompleted,
  activeNodeId,
  workspaceName,
  onZoomTo,
  navigateRequest,
}: Props) {
  const [byParent, setByParent] = useState<Map<string | null, Node[]>>(new Map())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropPos, setDropPos] = useState<DropPos | null>(null)
  const refs = useRef(new Map<string, HTMLDivElement>())
  // Mirror dragId / dropPos in refs so synthetic drag sequences (where
  // dragstart, dragover and drop dispatch back-to-back in the same
  // tick — see the WebView e2e harness) can read current values
  // without waiting for React's state batches to flush. State drives
  // rendering; refs drive the imperative branch logic.
  const dragIdRef = useRef<string | null>(null)
  const dropPosRef = useRef<DropPos | null>(null)

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
        // When hiding completed, skip the entire subtree rooted at a
        // completed node — Workflowy parity (a completed parent hides its
        // children too).
        if (hideCompleted && c.completed) continue
        out.push({ node: c, depth })
        walk(c.id, depth + 1)
      }
    }
    // When zoomed in, render only descendants of activeNodeId; otherwise the
    // whole workspace tree (parentId === null roots).
    walk(activeNodeId, 0)
    return out
  }, [byParent, activeNodeId, hideCompleted])

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
      if (intent.kind === 'toggle-complete') {
        await call('outline.update', {
          workspaceId,
          id: intent.nodeId,
          completed: intent.next,
        })
        await load()
        // Keep focus on the same node so further toggles work.
        setFocusId(intent.nodeId)
        return
      }
      if (intent.kind === 'start-thread') {
        await call('thread.start', { workspaceId, rootNodeId: intent.nodeId })
        await load()
        setFocusId(intent.nodeId)
        return
      }
    },
    [workspaceId, byParent, lookup, load, visible, activeNodeId, onZoomTo],
  )

  // ---------- Drag-and-drop ----------

  /**
   * Test whether `candidateAncestorId` is an ancestor of (or equal to)
   * `descendantId`. Used to reject drops that would create a cycle.
   */
  const isAncestor = useCallback(
    (candidateAncestorId: string, descendantId: string): boolean => {
      let cur: string | null = descendantId
      while (cur !== null) {
        if (cur === candidateAncestorId) return true
        const node = lookup.get(cur)
        if (!node) return false
        cur = node.parentId
      }
      return false
    },
    [lookup],
  )

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, n: Node) => {
      // Use the node id as the dataTransfer payload so external drops are no-ops.
      e.dataTransfer.setData('application/x-cedarpad-node', n.id)
      e.dataTransfer.effectAllowed = 'move'
      dragIdRef.current = n.id
      setDragId(n.id)
    },
    [],
  )

  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null
    dropPosRef.current = null
    setDragId(null)
    setDropPos(null)
  }, [])

  /**
   * Compute drop position from the pointer's Y within the target row:
   *   - top third → before
   *   - middle third → inside (nest as first child)
   *   - bottom third → after
   */
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, n: Node) => {
      const draggedId = dragIdRef.current
      if (!draggedId || draggedId === n.id) return
      // Reject drops onto a descendant of the dragged node — would create a cycle.
      if (isAncestor(draggedId, n.id)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const y = e.clientY - rect.top
      const h = rect.height
      let pos: DropPos
      if (y < h / 3) {
        pos = { kind: 'before', targetId: n.id, parentId: n.parentId }
      } else if (y > (2 * h) / 3) {
        pos = { kind: 'after', targetId: n.id, parentId: n.parentId }
      } else {
        pos = { kind: 'inside', targetId: n.id }
      }
      dropPosRef.current = pos
      setDropPos((cur) => {
        if (
          cur &&
          cur.kind === pos.kind &&
          (cur as { targetId?: string }).targetId === (pos as { targetId?: string }).targetId
        ) {
          return cur
        }
        return pos
      })
    },
    [isAncestor],
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>, n: Node) => {
      // Only clear when leaving the row entirely (not when crossing into a child).
      const related = e.relatedTarget as HTMLElement | null
      if (related && e.currentTarget.contains(related)) return
      if (
        dropPosRef.current &&
        (dropPosRef.current as { targetId?: string }).targetId === n.id
      ) {
        dropPosRef.current = null
      }
      setDropPos((cur) => {
        if (!cur) return null
        if ((cur as { targetId?: string }).targetId === n.id) return null
        return cur
      })
    },
    [],
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>, n: Node) => {
      e.preventDefault()
      const draggedId =
        e.dataTransfer.getData('application/x-cedarpad-node') || dragIdRef.current
      const pos = dropPosRef.current ?? dropPos
      dragIdRef.current = null
      dropPosRef.current = null
      setDragId(null)
      setDropPos(null)
      if (!draggedId || !pos || draggedId === n.id) return
      if (isAncestor(draggedId, n.id)) return

      let newParentId: string | null
      let prevSiblingId: string | null
      if (pos.kind === 'before') {
        newParentId = pos.parentId
        // Find the sibling immediately before targetId in pos.parentId.
        // Skip the dragged node itself if it's currently a sibling here, so
        // when reordering within the same parent we don't compute its
        // current slot as the prevSibling.
        const siblings = byParent.get(pos.parentId) ?? []
        const filtered = siblings.filter((s) => s.id !== draggedId)
        const targetIdx = filtered.findIndex((s) => s.id === pos.targetId)
        prevSiblingId = targetIdx > 0 ? filtered[targetIdx - 1]!.id : null
      } else if (pos.kind === 'after') {
        newParentId = pos.parentId
        prevSiblingId = pos.targetId
      } else {
        // inside → nest as first child
        newParentId = pos.targetId
        prevSiblingId = null
      }

      await call('outline.move', {
        workspaceId,
        id: draggedId,
        newParentId,
        prevSiblingId,
      })
      await load()
    },
    [dropPos, byParent, isAncestor, workspaceId, load],
  )

  // Test-only hook: lets the WebView e2e drive fixture turns without a
  // real Claude SDK. Exposed in dev / debug builds; harmless otherwise
  // (the e2e calls it explicitly). Lives on `window.cedarpadE2E` to keep
  // it off the public surface area.
  //
  // Slice 3 adds `sendPrompt` for the SDK runner end-to-end test —
  // streams events into a callback while the underlying IPC is in
  // flight, then reloads the tree once the turn completes.
  useEffect(() => {
    const hook = {
      appendTurn: async (
        threadRootId: string,
        blocks: Parameters<typeof call<'thread.appendTurn'>>[1]['blocks'],
      ) => {
        await call('thread.appendTurn', { workspaceId, threadRootId, blocks })
        await load()
      },
      sendPrompt: async (
        threadRootId: string,
        prompt: string,
        repoPath: string,
      ) => {
        const events: RunnerEvent[] = []
        const result = await streamSendPrompt(
          { workspaceId, threadRootId, prompt, repoPath },
          (ev) => {
            events.push(ev)
          },
        )
        await load()
        return { events, result }
      },
      reload: load,
    }
    ;(window as unknown as { cedarpadE2E?: typeof hook }).cedarpadE2E = hook
    return () => {
      delete (window as unknown as { cedarpadE2E?: typeof hook }).cedarpadE2E
    }
  }, [workspaceId, load])

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
        {visible.map(({ node, depth }) => {
          const { visual, blockMeta } = classifyNode(node)
          const editable = node.kind === 'content'
          const displayContent =
            node.kind === 'block' && blockMeta ? renderBlockContent(blockMeta) : node.content
          const isDropTarget = dropPos && (dropPos as { targetId?: string }).targetId === node.id
          const dropClass = isDropTarget ? `drop-${dropPos!.kind}` : ''
          const completedClass = node.completed ? 'completed' : ''
          const draggingClass = dragId === node.id ? 'dragging' : ''
          return (
            <div
              key={node.id}
              className={`tree-node visual-${visual} ${completedClass} ${dropClass} ${draggingClass}`
                .replace(/\s+/g, ' ')
                .trim()}
              data-visual={visual}
              data-kind={node.kind}
              data-node-id={node.id}
              style={{ paddingLeft: depth * 18 }}
              draggable
              onDragStart={(e) => handleDragStart(e, node)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, node)}
              onDragLeave={(e) => handleDragLeave(e, node)}
              onDrop={(e) => void handleDrop(e, node)}
            >
              <span className="bullet" aria-hidden>
                {bulletForVisual(visual)}
              </span>
              <div
                ref={(el) => {
                  if (el) refs.current.set(node.id, el)
                  else refs.current.delete(node.id)
                }}
                className="content"
                contentEditable={editable}
                suppressContentEditableWarning
                onInput={
                  editable ? (e) => handleInput(node.id, e.currentTarget.textContent ?? '') : undefined
                }
                onKeyDown={editable ? (e) => void handleKeyDown(e, node) : undefined}
              >
                {displayContent}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Render a Block Node's content based on its payload kind. Minimal —
 * UX iteration is a later slice. The point of slice 2 is the three
 * payload kinds are visually distinct so a user can tell them apart.
 */
function renderBlockContent(meta: BlockMetadata): string {
  const p = meta.payload
  if (p.kind === 'text') return p.text
  if (p.kind === 'tool_use') {
    const inputJson = JSON.stringify(p.input)
    return `${p.toolName}(${inputJson})`
  }
  // tool_result
  const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
  return p.isError ? `error: ${out}` : out
}
