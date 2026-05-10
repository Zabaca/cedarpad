import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, streamSendPrompt } from '../ipc'
import type { BlockMetadata, Node, RunnerEvent, TurnMetadata } from '../contract'
import { BlockMetadataSchema, TurnMetadataSchema } from '../contract'
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
  /** Absolute path to the workspace's repo — `cwd` for the Claude SDK. */
  repoPath: string
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

function classifyNode(
  n: Node,
): { visual: Visual; blockMeta?: BlockMetadata; turnMeta?: TurnMetadata } {
  if (n.kind === 'turn') {
    const parsed = TurnMetadataSchema.safeParse(n.metadata)
    return { visual: 'turn', turnMeta: parsed.success ? parsed.data : undefined }
  }
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
  repoPath,
  onZoomTo,
  navigateRequest,
}: Props) {
  const [byParent, setByParent] = useState<Map<string | null, Node[]>>(new Map())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropPos, setDropPos] = useState<DropPos | null>(null)
  /**
   * Slice 4: streaming run state.
   *
   * `streamingThreadRootId` is non-null while a Claude turn is in flight
   * for that Thread. Drives the running indicator and the cancel-shortcut
   * context. Cleared once the underlying `streamSendPrompt` promise
   * resolves (whether via natural completion, cancel, or error).
   *
   * `inFlightText` carries the accumulated `text-delta` content for any
   * currently-streaming text block, keyed by blockId. We render the
   * running text as an inline preview under the active streaming Turn so
   * the user sees Claude typing in real time. When `block-complete`
   * fires for a blockId we drop its entry — at that point a real Block
   * Node has been persisted and the next tree reload renders it.
   */
  const [streamingThreadRootId, setStreamingThreadRootId] = useState<string | null>(null)
  const [inFlightText, setInFlightText] = useState<Map<string, string>>(new Map())
  /**
   * Slice 5: which Block Node the user has selected as the source for a
   * branch operation. Block rows aren't contentEditable, so they don't
   * carry React's onKeyDown wiring; we track selection separately and a
   * window-level Cmd+Shift+B handler reads this state.
   */
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
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

  /**
   * True when there's a Turn Node child of `threadRootId` whose metadata
   * says `state: 'streaming'`. Used as the cancel-shortcut precondition.
   */
  const threadHasStreamingTurn = useCallback(
    (threadRootId: string): boolean => {
      const children = byParent.get(threadRootId) ?? []
      for (const c of children) {
        if (c.kind !== 'turn') continue
        const meta = TurnMetadataSchema.safeParse(c.metadata)
        if (meta.success && meta.data.state === 'streaming') return true
      }
      return false
    },
    [byParent],
  )

  /**
   * Run a Claude turn against the named Thread Root + prompt. Streams
   * RunnerEvents back; reloads the tree as Block Nodes land so the user
   * sees them appear; auto-creates a fresh empty prompt sibling on
   * natural completion so the next prompt slot is ready to type into.
   *
   * On cancel / error we don't auto-create the next prompt — the user is
   * presumably going to look at what happened first.
   */
  const runPrompt = useCallback(
    async (threadRootId: string, promptNodeId: string, prompt: string) => {
      setStreamingThreadRootId(threadRootId)
      setInFlightText(new Map())
      // Optimistically rewrite the prompt content (in case the user edited it).
      try {
        await call('outline.update', { workspaceId, id: promptNodeId, content: prompt })
      } catch {
        /* non-fatal */
      }
      try {
        const result = await streamSendPrompt(
          { workspaceId, threadRootId, prompt, repoPath },
          (ev) => {
            if (ev.kind === 'text-delta') {
              setInFlightText((prev) => {
                const next = new Map(prev)
                next.set(ev.blockId, (next.get(ev.blockId) ?? '') + ev.content)
                return next
              })
            } else if (ev.kind === 'block-complete') {
              // Persisted Block Node will appear after the next reload.
              setInFlightText((prev) => {
                if (!prev.has(ev.blockId)) return prev
                const next = new Map(prev)
                next.delete(ev.blockId)
                return next
              })
              void load()
            } else if (ev.kind === 'turn-complete') {
              void load()
            }
            // 'error' falls through; resolution is via `result.reason`.
          },
        )
        await load()
        if (result.reason === 'done') {
          // Auto-create a fresh empty prompt sibling under the Thread Root
          // so the user can keep typing without manually adding rows.
          try {
            const created = await call('outline.create', {
              workspaceId,
              parentId: threadRootId,
              content: '',
            })
            await load()
            setFocusId(created.id)
          } catch {
            /* non-fatal */
          }
        }
      } catch {
        // Underlying Tauri/sidecar error — leave streaming state cleared
        // below; the tree may still reflect partial Blocks.
      } finally {
        setStreamingThreadRootId(null)
        setInFlightText(new Map())
        await load()
      }
    },
    [workspaceId, repoPath, load],
  )

  const cancelTurn = useCallback(
    async (threadRootId: string) => {
      try {
        await call('sdk.cancel', { threadRootId })
      } catch {
        /* non-fatal */
      }
    },
    [],
  )

  /**
   * Slice 5: branch from a Block Node. Creates a sibling Thread under
   * the same Thread Root with full prior history through the source
   * Block, then focuses the new empty prompt slot.
   *
   * Cross-feature interaction with zoom (slice 7): if we're zoomed in
   * such that the new Thread would not be visible (it's outside the
   * zoom subtree), clear the zoom — the least-surprising of the two
   * options. Documented in the slice 5 issue.
   */
  const branchFromBlock = useCallback(
    async (blockId: string) => {
      try {
        const out = await call('thread.branch', { workspaceId, blockId })
        // If we're zoomed, decide whether the new Thread is visible.
        // Cheapest check: walk up `out.newThreadId`'s ancestry; if we
        // don't pass through `activeNodeId`, it's outside zoom — clear.
        if (activeNodeId !== null) {
          // We don't have the new Thread's parent chain in `lookup` yet
          // (we just inserted it). The parent IS the Thread Root the
          // user branched from, which is in `lookup`. So look up the
          // Thread Root via the source block's chain.
          const block = lookup.get(blockId)
          let cursor: string | null = block?.parentId ?? null
          let inZoom = false
          const seen = new Set<string>()
          while (cursor !== null) {
            if (cursor === activeNodeId) {
              inZoom = true
              break
            }
            if (seen.has(cursor)) break
            seen.add(cursor)
            const n = lookup.get(cursor)
            cursor = n?.parentId ?? null
          }
          if (!inZoom) onZoomTo(null)
        }
        await load()
        setSelectedBlockId(null)
        setFocusId(out.promptNodeId)
      } catch {
        /* non-fatal */
      }
    },
    [workspaceId, load, activeNodeId, lookup, onZoomTo],
  )

  // Window-level Cmd/Ctrl+Shift+B → branch from the selected Block.
  // Block rows aren't contentEditable so they don't carry per-row
  // onKeyDown; we attach at the document level and dispatch on the
  // tracked `selectedBlockId`. Down-arrow / up-arrow over sibling
  // Threads is handled here too — across sibling Thread Roots only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
        if (!selectedBlockId) return
        e.preventDefault()
        void branchFromBlock(selectedBlockId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedBlockId, branchFromBlock])

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
      const contentText = el.textContent ?? ''
      const isContentEmpty = contentText.trim().length === 0

      // Slice 4: a Content Node is a "prompt slot" when its parent is a
      // Thread Root. The keymap routes Cmd+Enter to send-prompt for prompt
      // slots and Cmd+Shift+. to cancel-turn when a Turn is streaming
      // under the same Thread Root.
      const promptThreadRootId =
        n.kind === 'content' &&
        parent &&
        parent.metadata &&
        (parent.metadata as { isThreadRoot?: unknown }).isThreadRoot === true
          ? parent.id
          : null
      const activeThreadHasStreamingTurn =
        promptThreadRootId !== null && threadHasStreamingTurn(promptThreadRootId)

      const intent = interpret(
        { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
        {
          node: n,
          parent,
          prevSibling,
          prevSiblingLastChildId,
          isContentEmpty,
          contentText,
          threadRootId: promptThreadRootId,
          activeThreadHasStreamingTurn,
        },
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
      if (intent.kind === 'send-prompt') {
        // Fire-and-forget — runPrompt manages its own streaming state and
        // tree reloads. We don't await here so the keydown handler stays
        // responsive (cancel must remain dispatchable while streaming).
        void runPrompt(intent.threadRootId, intent.nodeId, intent.prompt)
        return
      }
      if (intent.kind === 'cancel-turn') {
        void cancelTurn(intent.threadRootId)
        return
      }
    },
    [workspaceId, byParent, lookup, load, visible, activeNodeId, onZoomTo, threadHasStreamingTurn, runPrompt, cancelTurn],
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
      sendPromptFireAndForget: (
        threadRootId: string,
        prompt: string,
        repoPath: string,
      ) => {
        // Kick off a stream but don't await it — the spec drives the next
        // step (cancel) while it's still in flight.
        void streamSendPrompt(
          { workspaceId, threadRootId, prompt, repoPath },
          () => {
            void load()
          },
        ).then(() => load())
      },
      cancel: async (threadRootId: string) => {
        await call('sdk.cancel', { threadRootId })
        await load()
      },
      /**
       * Slice 4 crash-recovery test hook. Creates a Turn Node directly via
       * outline.create with `metadata.state = 'streaming'`, simulating
       * what we'd see on disk after a crash mid-turn — without needing to
       * actually kill the sidecar. The scan logic is the real subject of
       * the test, and it doesn't care HOW the streaming Turn got there.
       */
      createOrphanStreamingTurn: async (threadRootId: string) => {
        const turn = await call('outline.create', {
          workspaceId,
          parentId: threadRootId,
          content: '',
          kind: 'turn',
          metadata: { role: 'turn', threadRootId, state: 'streaming' },
        })
        await load()
        return turn.id
      },
      scanInterrupted: async () => {
        const out = await call('thread.scanInterrupted', { workspaceId })
        await load()
        return out
      },
      /**
       * Slice 5: drive the branch flow from an e2e spec without
       * synthesising a Cmd+Shift+B chord (modifier+letter chords are
       * unreliable against contentEditable in WebKit's WebDriver).
       *
       * `selectBlock` mirrors the user's click-to-select; `branch`
       * fires `thread.branch` and reloads the tree, returning the new
       * Thread Root and prompt slot ids so the spec can navigate to
       * them.
       */
      selectBlock: (blockId: string | null) => {
        setSelectedBlockId(blockId)
      },
      branch: async (blockId: string) => {
        const out = await call('thread.branch', { workspaceId, blockId })
        await load()
        return out
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
      {streamingThreadRootId !== null && (
        <div className="thread-running" data-testid="thread-running" role="status">
          <span className="dot" aria-hidden="true" />
          <span className="label">Claude is working — Cmd+Shift+. to cancel</span>
          {Array.from(inFlightText.entries()).map(([blockId, text]) => (
            <div key={blockId} className="thread-running-preview" data-testid="inflight-block">
              {text}
            </div>
          ))}
        </div>
      )}
      <div className="tree">
        {visible.map(({ node, depth }) => {
          const { visual, blockMeta, turnMeta } = classifyNode(node)
          const editable = node.kind === 'content'
          const displayContent =
            node.kind === 'block' && blockMeta ? renderBlockContent(blockMeta) : node.content
          const isDropTarget = dropPos && (dropPos as { targetId?: string }).targetId === node.id
          const dropClass = isDropTarget ? `drop-${dropPos!.kind}` : ''
          const completedClass = node.completed ? 'completed' : ''
          const draggingClass = dragId === node.id ? 'dragging' : ''
          const turnState = turnMeta?.state
          const turnStateClass = turnState ? `turn-state-${turnState}` : ''
          const branchedFrom =
            visual === 'thread-root'
              ? (node.metadata as { branchedFromBlockId?: unknown }).branchedFromBlockId
              : undefined
          const isBranchedThread = typeof branchedFrom === 'string'
          const branchClass = isBranchedThread ? 'branched-thread' : ''
          const selectedBlockClass =
            node.kind === 'block' && selectedBlockId === node.id ? 'block-selected' : ''
          return (
            <div
              key={node.id}
              className={`tree-node visual-${visual} ${completedClass} ${dropClass} ${draggingClass} ${turnStateClass} ${branchClass} ${selectedBlockClass}`
                .replace(/\s+/g, ' ')
                .trim()}
              data-visual={visual}
              data-kind={node.kind}
              data-node-id={node.id}
              data-turn-state={turnState ?? undefined}
              data-branched-from={typeof branchedFrom === 'string' ? branchedFrom : undefined}
              data-block-selected={
                node.kind === 'block' && selectedBlockId === node.id ? 'true' : undefined
              }
              style={{ paddingLeft: depth * 18 }}
              draggable
              onDragStart={(e) => handleDragStart(e, node)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, node)}
              onDragLeave={(e) => handleDragLeave(e, node)}
              onDrop={(e) => void handleDrop(e, node)}
              onClick={
                node.kind === 'block'
                  ? () => setSelectedBlockId((cur) => (cur === node.id ? null : node.id))
                  : undefined
              }
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
