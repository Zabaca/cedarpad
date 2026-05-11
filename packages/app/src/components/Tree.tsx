import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, streamSendPrompt } from '../ipc'
import type { BlockMetadata, Node, RunnerEvent, PromptMetadata } from '../contract'
import {
  BlockMetadataSchema,
  PromptMetadataSchema,
  SessionBearerMetadataSchema,
} from '../contract'
import { interpret } from '../keymap'
import { BlockRow, ToolPair } from './Block'
import { groupBlocksForRender } from './blockGrouping'
import { BranchesHeader } from './Branches'

type VisibleRow =
  | { kind: 'node'; node: Node; depth: number; pairLeadId?: string }
  | { kind: 'pair'; toolUse: Node; toolResult: Node; depth: number }

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

type DropPos =
  | { kind: 'before'; targetId: string; parentId: string | null }
  | { kind: 'after'; targetId: string; parentId: string | null }
  | { kind: 'inside'; targetId: string }

/**
 * Visual classification of a Node for rendering (v1.1 Shape B):
 *   - 'content'         — default outline node (or unsent draft)
 *   - 'session-bearer'  — Content Node carrying `metadata.sdkSessionId`
 *                         (the v1.1 replacement for Thread Root)
 *   - 'prompt'          — Content Node carrying `metadata.state`
 *                         (it's been sent — streaming/done/cancelled/interrupted)
 *   - 'block-text'      — Block Node carrying a `text` payload
 *   - 'block-tool-use'  — Block Node carrying a `tool_use` payload
 *   - 'block-tool-result' — Block Node carrying a `tool_result` payload
 *
 * A node may be BOTH a session-bearer and a Prompt (the root-level "Or"
 * case). We pick the more specific 'prompt' visual when both apply, and
 * surface the bearer status via `data-session-bearer="true"`.
 */
type Visual =
  | 'content'
  | 'session-bearer'
  | 'prompt'
  | 'block-text'
  | 'block-tool-use'
  | 'block-tool-result'
  | 'branches'

interface Classification {
  visual: Visual
  blockMeta?: BlockMetadata
  promptMeta?: PromptMetadata
  isSessionBearer: boolean
}

function classifyNode(n: Node): Classification {
  if (n.kind === 'branches') {
    return { visual: 'branches', isSessionBearer: false }
  }
  if (n.kind === 'block') {
    const parsed = BlockMetadataSchema.safeParse(n.metadata)
    if (parsed.success) {
      const k = parsed.data.payload.kind
      if (k === 'text') return { visual: 'block-text', blockMeta: parsed.data, isSessionBearer: false }
      if (k === 'tool_use')
        return { visual: 'block-tool-use', blockMeta: parsed.data, isSessionBearer: false }
      if (k === 'tool_result')
        return { visual: 'block-tool-result', blockMeta: parsed.data, isSessionBearer: false }
    }
    return { visual: 'block-text', isSessionBearer: false }
  }
  // Content Node — could be a draft, a Prompt, a session-bearer, or both.
  const bearerParsed = SessionBearerMetadataSchema.safeParse(n.metadata)
  const isSessionBearer =
    bearerParsed.success &&
    Object.prototype.hasOwnProperty.call(n.metadata, 'sdkSessionId')
  const promptParsed = PromptMetadataSchema.safeParse(n.metadata)
  const promptMeta = promptParsed.success && promptParsed.data.state ? promptParsed.data : undefined
  if (promptMeta) return { visual: 'prompt', promptMeta, isSessionBearer }
  if (isSessionBearer) return { visual: 'session-bearer', isSessionBearer: true }
  return { visual: 'content', isSessionBearer: false }
}

function hintForNode(n: Node): string {
  if (n.kind === 'branches') return 'Cmd+. zoom in · click chevron to fold/unfold'
  if (n.kind === 'block') return 'Cmd+. zoom in'
  // content
  const meta = n.metadata as PromptMetadata
  if (meta?.role === 'prompt') {
    return 'Cmd+Shift+B branch · Cmd+. zoom in · Shift+Tab outdent'
  }
  return 'Cmd+Enter send · Enter new sibling · Tab indent · Shift+Tab outdent · Cmd+. zoom in · Cmd+Shift+B branch'
}

function bulletForVisual(v: Visual): string {
  switch (v) {
    case 'session-bearer':
      return '>'
    case 'prompt':
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
   * v1.1: streaming Prompts (by id) and their accumulated in-flight
   * text. The Prompt id replaces v1's Thread Root id as the keying
   * concept — Block children land under the Prompt itself.
   */
  const [streamingPromptIds, setStreamingPromptIds] = useState<Set<string>>(new Set())
  const [inFlightText, setInFlightText] = useState<Map<string, string>>(new Map())
  /**
   * Per-block expansion state for tool blocks (v1.1 slice 3). Keyed by the
   * "lead" node id — for a ToolPair this is the tool_use Node id; for a
   * standalone tool_use / tool_result it is the node's own id. Absence ⇒
   * default-collapsed. Transient render-only state; not persisted.
   */
  const [expandedBlockIds, setExpandedBlockIds] = useState<Set<string>>(new Set())
  // Standard outline collapse for content/branches/block-bearing nodes.
  // Default expanded; opt-in collapse, transient client-side.
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set())
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedNodeIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const toggleExpanded = useCallback((id: string) => {
    setExpandedBlockIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  /**
   * v1.1 Branches containers (`kind: 'branches'`) render default-
   * collapsed (ADR-0006). The set tracks which containers the user has
   * expanded — anything not in the set is collapsed. We track EXPANDED
   * (rather than collapsed) so newly-created containers automatically
   * fall into the collapsed default without needing an explicit
   * tracker on every load.
   */
  const [expandedBranchesIds, setExpandedBranchesIds] = useState<Set<string>>(new Set())
  const refs = useRef(new Map<string, HTMLDivElement>())
  const dragIdRef = useRef<string | null>(null)
  const dropPosRef = useRef<DropPos | null>(null)

  const load = useCallback(async () => {
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
  // has something to type into. Also recover from a stale `activeNodeId`
  // pointing to a node that no longer exists (e.g. after a v1.1 DB wipe) —
  // load()'s BFS won't reach it, so byParent has no entry for it and the
  // seed below would silently skip.
  useEffect(() => {
    if (activeNodeId !== null && byParent.size > 0 && byParent.get(activeNodeId) === undefined) {
      onZoomTo(null)
      return
    }
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
  }, [byParent, workspaceId, load, activeNodeId, onZoomTo])

  useEffect(() => {
    if (!focusId) return
    const el = refs.current.get(focusId)
    if (el) {
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [focusId])

  useEffect(() => {
    if (!navigateRequest) return
    const el = refs.current.get(navigateRequest.id)
    if (!el) return
    setFocusId(navigateRequest.id)
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [navigateRequest])

  const visible: VisibleRow[] = useMemo(() => {
    const out: VisibleRow[] = []
    function walk(parentId: string | null, depth: number) {
      const children = byParent.get(parentId) ?? []
      const filtered = hideCompleted ? children.filter((c) => !c.completed) : children
      const grouped = groupBlocksForRender(filtered)
      for (const item of grouped) {
        if (item.kind === 'single') {
          out.push({ kind: 'node', node: item.node, depth })
          // v1.1: Branches containers render default-collapsed. Skip
          // descending unless the user explicitly expanded them.
          if (item.node.kind === 'branches' && !expandedBranchesIds.has(item.node.id)) continue
          // Standard outline collapse: skip children when user collapsed
          // this node. Branches containers are handled by their own state
          // above; blocks aren't typical container kinds but the same rule
          // is harmless for them.
          if (collapsedNodeIds.has(item.node.id)) continue
          walk(item.node.id, depth + 1)
        } else {
          // Pair: when expanded, render the two underlying Block rows
          // individually (and walk their children). When collapsed, render
          // a single combined ToolPair row. The pair is keyed by the
          // tool_use node id.
          if (expandedBlockIds.has(item.toolUse.id)) {
            // When the pair is expanded both halves toggle the pair's
            // collapse key (the tool_use Node id) so either chevron
            // re-collapses the pair. Pass `pairLeadId` through so the
            // dispatch site can route both onToggle calls to the same id.
            out.push({ kind: 'node', node: item.toolUse, depth, pairLeadId: item.toolUse.id })
            walk(item.toolUse.id, depth + 1)
            out.push({ kind: 'node', node: item.toolResult, depth, pairLeadId: item.toolUse.id })
            walk(item.toolResult.id, depth + 1)
          } else {
            out.push({ kind: 'pair', toolUse: item.toolUse, toolResult: item.toolResult, depth })
          }
        }
      }
    }
    walk(activeNodeId, 0)
    return out
  }, [byParent, activeNodeId, hideCompleted, expandedBlockIds, expandedBranchesIds, collapsedNodeIds])

  const lookup = useMemo(() => {
    const map = new Map<string, Node>()
    for (const list of byParent.values()) for (const n of list) map.set(n.id, n)
    return map
  }, [byParent])

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
      void call('outline.update', { workspaceId, id, content })
    },
    [workspaceId],
  )

  /**
   * Run a Claude turn for the given Prompt Node. Streams RunnerEvents
   * back and reloads the tree as Block Nodes land. On natural completion
   * an empty Content Node is auto-created as the next sibling of the
   * Prompt (under the same parent), and focused. On cancel/error we
   * leave the user in place to inspect.
   */
  const runPrompt = useCallback(
    async (promptNodeId: string, prompt: string) => {
      setStreamingPromptIds((prev) => {
        const next = new Set(prev)
        next.add(promptNodeId)
        return next
      })
      setInFlightText(new Map())
      // Optimistically rewrite the prompt content (in case the user edited it).
      try {
        await call('outline.update', { workspaceId, id: promptNodeId, content: prompt })
      } catch {
        /* non-fatal */
      }
      try {
        const result = await streamSendPrompt(
          { workspaceId, promptNodeId, prompt, repoPath },
          (ev) => {
            if (ev.kind === 'text-delta') {
              setInFlightText((prev) => {
                const next = new Map(prev)
                next.set(ev.blockId, (next.get(ev.blockId) ?? '') + ev.content)
                return next
              })
            } else if (ev.kind === 'block-complete') {
              setInFlightText((prev) => {
                if (!prev.has(ev.blockId)) return prev
                const next = new Map(prev)
                next.delete(ev.blockId)
                return next
              })
              void load()
            } else if (ev.kind === 'prompt-complete') {
              void load()
            }
          },
        )
        await load()
        if (result.reason === 'done') {
          // Auto-create empty next-prompt-slot as the immediate next
          // sibling of the Prompt (under whatever container it lives in).
          try {
            const promptNode = await call('outline.get', { workspaceId, id: promptNodeId })
            if (promptNode) {
              const created = await call('outline.create', {
                workspaceId,
                parentId: promptNode.parentId,
                prevSiblingId: promptNode.id,
                content: '',
              })
              await load()
              setFocusId(created.id)
            }
          } catch {
            /* non-fatal */
          }
        }
      } catch {
        /* non-fatal */
      } finally {
        setStreamingPromptIds((prev) => {
          if (!prev.has(promptNodeId)) return prev
          const next = new Set(prev)
          next.delete(promptNodeId)
          return next
        })
        setInFlightText(new Map())
        await load()
      }
    },
    [workspaceId, repoPath, load],
  )

  const cancelPrompt = useCallback(async (promptNodeId: string) => {
    try {
      await call('sdk.cancel', { promptNodeId })
    } catch {
      /* non-fatal */
    }
  }, [])

  /**
   * Cmd+Shift+B handler — fires `thread.branch` against the focused
   * Content Node. The sidecar's `forkAtPrompt` does the eager SDK fork
   * and materializes the Branches container + new Branch. We auto-
   * expand the resulting container so the new Branch is visible and
   * focus the new Prompt slot for typing.
   */
  const handleBranch = useCallback(
    async (sourceNodeId: string) => {
      try {
        const out = await call('thread.branch', { workspaceId, sourceNodeId })
        await load()
        setExpandedBranchesIds((prev) => {
          if (prev.has(out.branchesContainerId)) return prev
          const next = new Set(prev)
          next.add(out.branchesContainerId)
          return next
        })
        setFocusId(out.promptNodeId)
      } catch {
        /* non-fatal */
      }
    },
    [workspaceId, load],
  )

  const toggleBranches = useCallback((containerId: string) => {
    setExpandedBranchesIds((prev) => {
      const next = new Set(prev)
      if (next.has(containerId)) next.delete(containerId)
      else next.add(containerId)
      return next
    })
  }, [])

  /**
   * v1.1 send-prompt routing. Implements the three behaviours the
   * threadEngine's `sendPrompt` would handle, but inline against the
   * IPC + outline layer:
   *   - Root-level Content Node → "Or" bootstrap: stamp self as
   *     session-bearer, create empty child, focus it. No SDK call.
   *   - Non-root + parent already a session-bearer → just run the SDK
   *     under the existing session.
   *   - Non-root + parent not a session-bearer → stamp parent first,
   *     then run the SDK.
   *
   * The threadEngine's `sendPrompt` is the canonical implementation;
   * the renderer reproduces the dispatch here because the SDK runner's
   * IPC entry (`sdk.sendPrompt`) is a streaming method and the renderer
   * needs to thread its result through `runPrompt` for UI side effects.
   */
  const handleSendPrompt = useCallback(
    async (nodeId: string, prompt: string) => {
      const node = lookup.get(nodeId)
      if (!node) return
      const isRootLevel = node.parentId === null
      if (isRootLevel) {
        // "Or" bootstrap.
        await call('outline.update', {
          workspaceId,
          id: nodeId,
          metadata: { ...node.metadata, sdkSessionId: null },
        })
        const existingChildren = byParent.get(nodeId) ?? []
        const lastChildId =
          existingChildren.length > 0 ? existingChildren[existingChildren.length - 1]!.id : null
        const created = await call('outline.create', {
          workspaceId,
          parentId: nodeId,
          prevSiblingId: lastChildId,
          content: '',
        })
        await load()
        setFocusId(created.id)
        return
      }
      // Non-root: stamp parent if needed, then run.
      const parent = node.parentId ? lookup.get(node.parentId) : null
      if (parent && !Object.prototype.hasOwnProperty.call(parent.metadata, 'sdkSessionId')) {
        await call('outline.update', {
          workspaceId,
          id: parent.id,
          metadata: { ...parent.metadata, sdkSessionId: null },
        })
      }
      // Mark the Prompt as streaming up front so the UI shows the
      // pulse + cancel option before the SDK begins yielding.
      await call('outline.update', {
        workspaceId,
        id: nodeId,
        metadata: { ...node.metadata, state: 'streaming' },
      })
      await load()
      void runPrompt(nodeId, prompt)
    },
    [workspaceId, lookup, byParent, load, runPrompt],
  )

  /**
   * Pick a streaming Prompt id to cancel given the focused node.
   * Walks the focused node's subtree (then ancestry as a fallback)
   * looking for a Content Node currently in `state: 'streaming'`.
   */
  const findStreamingPromptId = useCallback(
    (focusedId: string | null): string | null => {
      if (!focusedId) return null
      // First: is the focused node itself a streaming Prompt?
      if (streamingPromptIds.has(focusedId)) return focusedId
      // Otherwise walk ancestry: find a streaming sibling under the
      // same session-bearer ancestor.
      let cursor: string | null = focusedId
      const seen = new Set<string>()
      while (cursor !== null) {
        if (seen.has(cursor)) break
        seen.add(cursor)
        const node = lookup.get(cursor)
        if (!node) break
        const siblings = byParent.get(node.parentId) ?? []
        for (const s of siblings) {
          if (streamingPromptIds.has(s.id)) return s.id
        }
        cursor = node.parentId
      }
      // Last resort: any streaming prompt anywhere.
      const it = streamingPromptIds.values().next()
      return it.done ? null : it.value
    },
    [streamingPromptIds, lookup, byParent],
  )

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLDivElement>, n: Node) => {
      // Vertical navigation through the visible rows. Handled at the
      // renderer because it depends on the rendered row order (which
      // accounts for collapse, hide-completed, etc.) — not a structural
      // outline operation.
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        const idxInVisible = visible.findIndex(
          (r) => (r.kind === 'node' ? r.node.id : r.toolUse.id) === n.id,
        )
        if (idxInVisible === -1) return
        const dir = e.key === 'ArrowDown' ? 1 : -1
        for (let i = idxInVisible + dir; i >= 0 && i < visible.length; i += dir) {
          const r = visible[i]!
          // Only content nodes are contenteditable / focusable. Block rows
          // and pair rows render through BlockRow/ToolPair as static divs,
          // so .focus() on them no-ops; skip past them.
          if (r.kind !== 'node' || r.node.kind !== 'content') continue
          const targetEl = refs.current.get(r.node.id)
          if (targetEl) {
            e.preventDefault()
            targetEl.focus()
            setFocusId(r.node.id)
            return
          }
        }
        return
      }

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

      const intent = interpret(
        { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
        {
          node: n,
          parent,
          prevSibling,
          prevSiblingLastChildId,
          isContentEmpty,
          contentText,
          streamingPromptId: findStreamingPromptId(n.id),
        },
      )

      if (intent.kind === 'noop') return
      e.preventDefault()

      if (intent.kind === 'zoom-in') {
        onZoomTo(intent.nodeId)
        return
      }
      if (intent.kind === 'zoom-out') {
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
        const flat = visible
        const rowNodeId = (r: VisibleRow): string =>
          r.kind === 'node' ? r.node.id : r.toolUse.id
        const myIdx = flat.findIndex((v) => rowNodeId(v) === intent.nodeId)
        const prev = myIdx > 0 ? flat[myIdx - 1] : null
        await call('outline.delete', { workspaceId, id: intent.nodeId })
        await load()
        if (prev) setFocusId(rowNodeId(prev))
        return
      }
      if (intent.kind === 'toggle-complete') {
        await call('outline.update', {
          workspaceId,
          id: intent.nodeId,
          completed: intent.next,
        })
        await load()
        setFocusId(intent.nodeId)
        return
      }
      if (intent.kind === 'send-prompt') {
        void handleSendPrompt(intent.nodeId, intent.prompt)
        return
      }
      if (intent.kind === 'cancel-prompt') {
        void cancelPrompt(intent.promptNodeId)
        return
      }
      if (intent.kind === 'branch-prompt') {
        void handleBranch(intent.sourceNodeId)
        return
      }
    },
    [
      workspaceId,
      byParent,
      lookup,
      load,
      visible,
      activeNodeId,
      onZoomTo,
      handleSendPrompt,
      cancelPrompt,
      handleBranch,
      findStreamingPromptId,
    ],
  )

  // ---------- Drag-and-drop ----------

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

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, n: Node) => {
    e.dataTransfer.setData('application/x-cedarpad-node', n.id)
    e.dataTransfer.effectAllowed = 'move'
    dragIdRef.current = n.id
    setDragId(n.id)
  }, [])

  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null
    dropPosRef.current = null
    setDragId(null)
    setDropPos(null)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, n: Node) => {
      const draggedId = dragIdRef.current
      if (!draggedId || draggedId === n.id) return
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

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>, n: Node) => {
    const related = e.relatedTarget as HTMLElement | null
    if (related && e.currentTarget.contains(related)) return
    if (dropPosRef.current && (dropPosRef.current as { targetId?: string }).targetId === n.id) {
      dropPosRef.current = null
    }
    setDropPos((cur) => {
      if (!cur) return null
      if ((cur as { targetId?: string }).targetId === n.id) return null
      return cur
    })
  }, [])

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
        const siblings = byParent.get(pos.parentId) ?? []
        const filtered = siblings.filter((s) => s.id !== draggedId)
        const targetIdx = filtered.findIndex((s) => s.id === pos.targetId)
        prevSiblingId = targetIdx > 0 ? filtered[targetIdx - 1]!.id : null
      } else if (pos.kind === 'after') {
        newParentId = pos.parentId
        prevSiblingId = pos.targetId
      } else {
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

  // Test-only hook for the WebView e2e harness. Lives on
  // `window.cedarpadE2E` to keep it off the public surface area.
  useEffect(() => {
    const hook = {
      sendPrompt: async (promptNodeId: string, prompt: string) => {
        const events: RunnerEvent[] = []
        const result = await streamSendPrompt(
          { workspaceId, promptNodeId, prompt, repoPath },
          (ev) => {
            events.push(ev)
          },
        )
        await load()
        return { events, result }
      },
      sendPromptFireAndForget: (promptNodeId: string, prompt: string) => {
        void streamSendPrompt(
          { workspaceId, promptNodeId, prompt, repoPath },
          () => {
            void load()
          },
        ).then(() => load())
      },
      cancel: async (promptNodeId: string) => {
        await call('sdk.cancel', { promptNodeId })
        await load()
      },
      /**
       * Crash-recovery test hook (v1.1): create a Content Node directly
       * with `metadata.state = 'streaming'`, simulating an interrupted
       * Prompt without needing to actually kill the sidecar.
       */
      createOrphanStreamingPrompt: async (parentId: string) => {
        const node = await call('outline.create', {
          workspaceId,
          parentId,
          content: '',
          kind: 'content',
          metadata: { state: 'streaming' },
        })
        await load()
        return node.id
      },
      scanInterrupted: async () => {
        const out = await call('thread.scanInterrupted', { workspaceId })
        await load()
        return out
      },
      /**
       * v1.1 branch verb e2e hook. Fires the same `thread.branch` IPC
       * the keymap dispatches against, auto-expands the resulting
       * Branches container so the spec can read the new Branch
       * structurally without simulating a click on the chevron, and
       * returns the engine's ids.
       */
      branch: async (sourceNodeId: string) => {
        const out = await call('thread.branch', { workspaceId, sourceNodeId })
        setExpandedBranchesIds((prev) => {
          if (prev.has(out.branchesContainerId)) return prev
          const next = new Set(prev)
          next.add(out.branchesContainerId)
          return next
        })
        await load()
        return out
      },
      /**
       * Toggle expansion of a Branches container — used by e2e specs to
       * exercise the default-collapsed render path.
       */
      toggleBranches: (containerId: string) => {
        setExpandedBranchesIds((prev) => {
          const next = new Set(prev)
          if (next.has(containerId)) next.delete(containerId)
          else next.add(containerId)
          return next
        })
      },
      reload: load,
    }
    ;(window as unknown as { cedarpadE2E?: typeof hook }).cedarpadE2E = hook
    return () => {
      delete (window as unknown as { cedarpadE2E?: typeof hook }).cedarpadE2E
    }
  }, [workspaceId, load, repoPath])

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
      {streamingPromptIds.size > 0 && (
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
        {visible.map((row) => {
          if (row.kind === 'pair') {
            const { toolUse, toolResult, depth } = row
            return (
              <ToolPair
                key={`pair-${toolUse.id}`}
                toolUse={toolUse}
                toolResult={toolResult}
                depth={depth}
                onToggle={() => toggleExpanded(toolUse.id)}
              />
            )
          }
          const { node, depth, pairLeadId } = row
          // v1.1: Branches containers render via their own header
          // component with chevron + child count. They have no editable
          // text content of their own — the toggle is the entire row.
          if (node.kind === 'branches') {
            const childCount = (byParent.get(node.id) ?? []).length
            return (
              <BranchesHeader
                key={node.id}
                container={node}
                childCount={childCount}
                expanded={expandedBranchesIds.has(node.id)}
                onToggle={toggleBranches}
                depth={depth}
              />
            )
          }
          const { visual, blockMeta, promptMeta, isSessionBearer } = classifyNode(node)
          const isDropTarget = dropPos && (dropPos as { targetId?: string }).targetId === node.id
          const dropClass = isDropTarget ? `drop-${dropPos!.kind}` : ''
          const draggingClass = dragId === node.id ? 'dragging' : ''
          if (node.kind === 'block' && blockMeta) {
            const toggleKey = pairLeadId ?? node.id
            // When this block is part of an expanded pair the pair-key is
            // present in expandedBlockIds → both halves render in their
            // expanded shape. Otherwise the lone block follows its own
            // expansion state.
            const expanded = expandedBlockIds.has(toggleKey)
            return (
              <BlockRow
                key={node.id}
                node={node}
                depth={depth}
                collapsed={!expanded}
                onToggle={() => toggleExpanded(toggleKey)}
                draggable
                attachRef={(el) => {
                  if (el) refs.current.set(node.id, el)
                  else refs.current.delete(node.id)
                }}
                dropClass={dropClass}
                draggingClass={draggingClass}
                onDragStart={(e) => handleDragStart(e, node)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, node)}
                onDragLeave={(e) => handleDragLeave(e, node)}
                onDrop={(e) => void handleDrop(e, node)}
              />
            )
          }
          const editable = node.kind === 'content'
          const completedClass = node.completed ? 'completed' : ''
          const promptState = promptMeta?.state
          const promptStateClass = promptState ? `prompt-state-${promptState}` : ''
          const sessionBearerClass = isSessionBearer ? 'session-bearer' : ''
          return (
            <div
              key={node.id}
              className={`tree-node visual-${visual} ${completedClass} ${dropClass} ${draggingClass} ${promptStateClass} ${sessionBearerClass}`
                .replace(/\s+/g, ' ')
                .trim()}
              data-visual={visual}
              data-kind={node.kind}
              data-node-id={node.id}
              data-prompt-state={promptState ?? undefined}
              data-session-bearer={isSessionBearer ? 'true' : undefined}
              style={{ paddingLeft: depth * 18 }}
              draggable
              onDragStart={(e) => handleDragStart(e, node)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, node)}
              onDragLeave={(e) => handleDragLeave(e, node)}
              onDrop={(e) => void handleDrop(e, node)}
            >
              {(() => {
                const kids = byParent.get(node.id) ?? []
                if (node.kind !== 'content' || kids.length === 0) {
                  return (
                    <span className="bullet" aria-hidden>
                      {bulletForVisual(visual)}
                    </span>
                  )
                }
                const collapsed = collapsedNodeIds.has(node.id)
                return (
                  <button
                    type="button"
                    className="collapse-toggle"
                    aria-label={collapsed ? 'Expand' : 'Collapse'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleCollapsed(node.id)
                    }}
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                )
              })()}
              <div
                ref={(el) => {
                  if (el) refs.current.set(node.id, el)
                  else refs.current.delete(node.id)
                }}
                className="content"
                contentEditable={editable}
                suppressContentEditableWarning
                onFocus={editable ? () => setFocusId(node.id) : undefined}
                onInput={
                  editable
                    ? (e) => handleInput(node.id, e.currentTarget.textContent ?? '')
                    : undefined
                }
                onKeyDown={editable ? (e) => void handleKeyDown(e, node) : undefined}
              >
                {node.content}
              </div>
              {focusId === node.id ? (
                <div className="node-hint">{hintForNode(node)}</div>
              ) : null}
            </div>
          )
        })}
        <button
          type="button"
          className="add-node"
          data-testid="add-node"
          onClick={() => {
            void (async () => {
              const parentId =
                activeNodeId !== null && !lookup.get(activeNodeId) ? null : activeNodeId
              const siblings = byParent.get(parentId) ?? []
              const last = siblings[siblings.length - 1]
              const created = await call('outline.create', {
                workspaceId,
                parentId,
                prevSiblingId: last?.id ?? null,
                content: '',
              })
              await load()
              setFocusId(created.id)
            })()
          }}
        >
          + Add node
        </button>
      </div>
    </div>
  )
}

