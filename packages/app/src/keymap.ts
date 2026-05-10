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
 *   - Cmd/Ctrl + .     → zoom into the focused node
 *   - Cmd/Ctrl + ,     → zoom out one level
 *   - Cmd/Ctrl+Enter   → on a Content Node: send it as a Prompt (v1.1).
 *                        This is the SOLE conversation-starting verb.
 *                        Cmd+Shift+T is gone (v1.0 removal per ADR-0006).
 *   - Cmd/Ctrl+Shift+. → cancel the in-flight Claude turn for the
 *                        Prompt's session-bearer.
 *   - Cmd/Ctrl+Shift+B → branch verb (ADR-0006). Fires the sole
 *                        `branch-prompt` intent when focus is on a
 *                        Content Node. v1's block-level branching is
 *                        dropped; Block rows are not contentEditable so
 *                        the keydown handler never reaches them.
 *
 * Cmd+Enter "Or" semantics (decided by the renderer based on tree
 * position; the keymap returns one intent kind):
 *   - On a Content Node whose parent is a session-bearer → send as
 *     Prompt under existing session.
 *   - On a Content Node whose parent is NOT a session-bearer →
 *     auto-stamp parent + send as Prompt.
 *   - On a root-level Content Node → self-stamp as session-bearer +
 *     create empty child Prompt + focus it (no SDK call).
 *
 * The keymap surfaces a single `send-prompt` intent for all three;
 * `threadEngine.sendPrompt` decides which behaviour to run.
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
  | { kind: 'send-prompt'; nodeId: string; prompt: string }
  | { kind: 'cancel-prompt'; promptNodeId: string }
  | { kind: 'branch-prompt'; sourceNodeId: string }

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
     * Id of the streaming Prompt the user might want to cancel —
     * typically the most recent Prompt under the focused node's
     * session-bearer ancestor that has `state: 'streaming'`. The
     * renderer computes this; the keymap just routes Cmd+Shift+. to it.
     */
    streamingPromptId?: string | null
  },
): Intent {
  const mod = ev.metaKey || ev.ctrlKey
  // Cancel-prompt: Cmd/Ctrl + Shift + . — checked BEFORE plain Cmd+. so
  // the shift-variant wins.
  if (mod && ev.shiftKey && ev.key === '.') {
    if (ctx.streamingPromptId) {
      return { kind: 'cancel-prompt', promptNodeId: ctx.streamingPromptId }
    }
    return { kind: 'noop' }
  }
  if (mod && ev.key === '.') {
    return { kind: 'zoom-in', nodeId: ctx.node.id }
  }
  if (mod && ev.key === ',') {
    return { kind: 'zoom-out' }
  }
  // Cmd/Ctrl+Shift+B — branch verb (ADR-0006). The single fork gesture
  // for v1.1. Only Content Nodes are valid sources; Block rows aren't
  // contentEditable so this handler never runs against them in practice,
  // but we gate explicitly for safety.
  if (mod && ev.shiftKey && (ev.key === 'b' || ev.key === 'B')) {
    if (ctx.node.kind !== 'content') return { kind: 'noop' }
    return { kind: 'branch-prompt', sourceNodeId: ctx.node.id }
  }
  // Cmd/Ctrl+Enter on a Content Node sends it as a Prompt. v1.1 makes
  // this the sole conversation-starting verb — there's no separate
  // start-thread gesture. The threadEngine decides what "send" means
  // based on the node's tree position (root-level "Or" semantics vs.
  // ordinary send).
  //
  // Empty content + non-root → noop (no point sending an empty prompt).
  // Empty content + root-level → still triggers (the "Or" bootstrap
  // doesn't need text); the threadEngine ignores the prompt string in
  // that branch.
  if (ev.key === 'Enter' && mod) {
    if (ctx.node.kind !== 'content') return { kind: 'noop' }
    const prompt = (ctx.contentText ?? '').trim()
    const isRootLevel = ctx.parent === null
    if (prompt.length === 0 && !isRootLevel) return { kind: 'noop' }
    return { kind: 'send-prompt', nodeId: ctx.node.id, prompt }
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
  return { kind: 'noop' }
}
