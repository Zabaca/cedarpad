import type { Node } from './contract'

/**
 * Pure keymap interpretation. Given the focused node + its visible siblings,
 * return the intent. The renderer translates intents into IPC calls.
 *
 * This is split out of the React component so it's unit-testable without
 * jsdom mounting the tree.
 *
 * Bindings:
 *   - Enter            → create sibling
 *   - Tab              → nest under prevSibling
 *   - Shift+Tab        → outdent to grandparent
 *   - Backspace (empty)→ delete this node
 *   - Cmd/Ctrl + .     → zoom into the focused node (slice 7)
 *   - Cmd/Ctrl + ,     → zoom out one level (slice 7)
 *   - Cmd/Ctrl+Enter   → on a Content Node inside a Thread (child of a
 *                        Thread Root): send the prompt to Claude.
 *                      → otherwise: toggle `completed` on the focused
 *                        Content Node (slice 9).
 *   - Cmd/Ctrl+Shift+. → cancel the in-flight Claude turn for the active
 *                        Thread (slice 4). Distinct from Cmd+. (zoom-in).
 *   - Cmd/Ctrl+Shift+T → start a Thread on this Content Node (slice 2)
 *   - Cmd/Ctrl+Shift+B → branch from a Block Node — fork into a sibling
 *                        Thread carrying full history through this Block
 *                        (slice 5). The renderer translates the intent
 *                        into a `thread.branch` call.
 *
 * Visual treatments paired with the kinds (slice 2):
 *   - Content Node: default bullet
 *   - Thread Root: Content Node whose metadata has `isThreadRoot: true`,
 *     rendered with a different bullet (>) and accent border.
 *   - Turn Node: rendered as a labelled "Claude turn" row.
 *   - Block Node: three sub-styles via metadata.payload.kind —
 *     text → prose, tool_use → inline tool call card, tool_result → output.
 */
export type Intent =
  | { kind: 'noop' }
  | { kind: 'create-sibling'; afterId: string; parentId: string | null }
  | { kind: 'nest'; nodeId: string; newParentId: string; prevSiblingId: string | null }
  | { kind: 'outdent'; nodeId: string; newParentId: string | null; prevSiblingId: string }
  | { kind: 'delete-empty'; nodeId: string }
  | { kind: 'zoom-in'; nodeId: string }
  | { kind: 'zoom-out' }
  | { kind: 'toggle-complete'; nodeId: string; next: boolean }
  | { kind: 'start-thread'; nodeId: string }
  | { kind: 'send-prompt'; nodeId: string; threadRootId: string; prompt: string }
  | { kind: 'cancel-turn'; threadRootId: string }
  | { kind: 'branch-from-block'; blockId: string }

export interface Visible {
  node: Node
  parent: Node | null
  prevSibling: Node | null
  /** Last child of prevSibling — used as the prevSiblingId when nesting. */
  prevSiblingLastChildId: string | null
}

export function interpret(
  ev: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ctx: Visible & {
    isContentEmpty: boolean
    /** Current text content of the focused cell (for send-prompt). */
    contentText?: string
    /**
     * Id of the Thread Root the focused Content Node belongs to, if any.
     * Set when the focused Node's parent (or further ancestor — but slice 4
     * only sends from direct children) is a Thread Root. When set,
     * Cmd+Enter sends the prompt instead of toggling complete.
     */
    threadRootId?: string | null
    /**
     * True when there's a streaming Turn under the active Thread Root —
     * Cmd+Shift+. routes to cancel-turn rather than no-op.
     */
    activeThreadHasStreamingTurn?: boolean
  },
): Intent {
  // Workflowy-style zoom: Cmd/Ctrl + . zooms into focused node, Cmd/Ctrl + ,
  // zooms out one level. Both must be the modifier-combo (no plain `.`/`,`
  // because those are valid text input).
  const mod = ev.metaKey || ev.ctrlKey
  // Cancel-turn: Cmd/Ctrl + Shift + . — checked BEFORE plain Cmd+. so the
  // shift-variant wins.
  if (mod && ev.shiftKey && ev.key === '.') {
    if (ctx.threadRootId && ctx.activeThreadHasStreamingTurn) {
      return { kind: 'cancel-turn', threadRootId: ctx.threadRootId }
    }
    return { kind: 'noop' }
  }
  if (mod && ev.key === '.') {
    return { kind: 'zoom-in', nodeId: ctx.node.id }
  }
  if (mod && ev.key === ',') {
    return { kind: 'zoom-out' }
  }
  // Cmd/Ctrl+Enter on a prompt slot (Content Node child of a Thread Root)
  // sends the prompt to Claude. Otherwise it toggles completion. The
  // disambiguator is `threadRootId` — only set by the renderer for prompt
  // slots, which makes "complete this prompt" semantically nonsensical
  // anyway.
  if (ev.key === 'Enter' && mod) {
    if (ctx.threadRootId && ctx.node.kind === 'content') {
      const prompt = (ctx.contentText ?? '').trim()
      if (prompt.length === 0) return { kind: 'noop' }
      return {
        kind: 'send-prompt',
        nodeId: ctx.node.id,
        threadRootId: ctx.threadRootId,
        prompt,
      }
    }
    return { kind: 'toggle-complete', nodeId: ctx.node.id, next: !ctx.node.completed }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    return { kind: 'create-sibling', afterId: ctx.node.id, parentId: ctx.node.parentId }
  }
  if (ev.key === 'Tab' && !ev.shiftKey) {
    if (!ctx.prevSibling) return { kind: 'noop' }
    return {
      kind: 'nest',
      nodeId: ctx.node.id,
      newParentId: ctx.prevSibling.id,
      prevSiblingId: ctx.prevSiblingLastChildId,
    }
  }
  if (ev.key === 'Tab' && ev.shiftKey) {
    if (!ctx.parent) return { kind: 'noop' }
    return {
      kind: 'outdent',
      nodeId: ctx.node.id,
      newParentId: ctx.parent.parentId,
      prevSiblingId: ctx.parent.id,
    }
  }
  if (ev.key === 'Backspace' && ctx.isContentEmpty) {
    return { kind: 'delete-empty', nodeId: ctx.node.id }
  }
  // Cmd/Ctrl + Shift + T → start a Thread on a Content Node.
  if ((ev.key === 't' || ev.key === 'T') && ev.shiftKey && (ev.metaKey || ev.ctrlKey)) {
    if (ctx.node.kind !== 'content') return { kind: 'noop' }
    return { kind: 'start-thread', nodeId: ctx.node.id }
  }
  return { kind: 'noop' }
}
