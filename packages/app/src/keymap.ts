import type { Node } from './contract'

/**
 * Pure keymap interpretation. Given the focused node + its visible siblings,
 * return the intent. The renderer translates intents into IPC calls.
 *
 * This is split out of the React component so it's unit-testable without
 * jsdom mounting the tree.
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

export interface Visible {
  node: Node
  parent: Node | null
  prevSibling: Node | null
  /** Last child of prevSibling — used as the prevSiblingId when nesting. */
  prevSiblingLastChildId: string | null
}

export function interpret(
  ev: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ctx: Visible & { isContentEmpty: boolean },
): Intent {
  // Workflowy-style zoom: Cmd/Ctrl + . zooms into focused node, Cmd/Ctrl + ,
  // zooms out one level. Both must be the modifier-combo (no plain `.`/`,`
  // because those are valid text input).
  const mod = ev.metaKey || ev.ctrlKey
  if (mod && ev.key === '.') {
    return { kind: 'zoom-in', nodeId: ctx.node.id }
  }
  if (mod && ev.key === ',') {
    return { kind: 'zoom-out' }
  }
  // Cmd/Ctrl+Enter toggles `completed` on the focused Content Node.
  // Workflowy uses Cmd+Enter for the same operation. Checked before the
  // plain Enter case so the modifier wins.
  if (ev.key === 'Enter' && mod) {
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
  return { kind: 'noop' }
}
