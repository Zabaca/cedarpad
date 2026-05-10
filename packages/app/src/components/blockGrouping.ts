/**
 * Pure-function pair-grouping for Block Nodes under a Prompt.
 *
 * The DB stores `tool_use` and `tool_result` Blocks as two separate sibling
 * Nodes. At render time, an adjacent pair whose `tool_use_id` matches is
 * collapsed into a single `ToolPair` visual unit (one chevron toggles both).
 *
 * Inputs are arbitrary Node siblings (callers commonly pass the children of a
 * Prompt). Non-block nodes pass through untouched as `single` render items —
 * the function only groups Block-kind nodes.
 *
 * No store dependency. No React. Easy to test.
 */
import type { Node } from '../contract'
import { BlockMetadataSchema } from '../contract'

export type RenderItem =
  | { kind: 'single'; node: Node }
  | { kind: 'pair'; toolUse: Node; toolResult: Node }

function blockPayload(n: Node): { kind: 'text' | 'tool_use' | 'tool_result'; toolUseId?: string } | null {
  if (n.kind !== 'block') return null
  const parsed = BlockMetadataSchema.safeParse(n.metadata)
  if (!parsed.success) return null
  const p = parsed.data.payload
  if (p.kind === 'text') return { kind: 'text' }
  if (p.kind === 'tool_use') return { kind: 'tool_use', toolUseId: p.toolUseId }
  return { kind: 'tool_result', toolUseId: p.toolUseId }
}

export function groupBlocksForRender(nodes: Node[]): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < nodes.length) {
    const cur = nodes[i]!
    const curPayload = blockPayload(cur)
    if (curPayload?.kind === 'tool_use' && curPayload.toolUseId !== undefined) {
      const next = nodes[i + 1]
      const nextPayload = next ? blockPayload(next) : null
      if (
        nextPayload?.kind === 'tool_result' &&
        nextPayload.toolUseId !== undefined &&
        nextPayload.toolUseId === curPayload.toolUseId
      ) {
        out.push({ kind: 'pair', toolUse: cur, toolResult: next! })
        i += 2
        continue
      }
    }
    out.push({ kind: 'single', node: cur })
    i += 1
  }
  return out
}
