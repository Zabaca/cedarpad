/**
 * Block Node rendering for the conversation tree (v1.1 slice 3).
 *
 * Two render shapes:
 *   - <BlockRow>  — one Block Node (text / tool_use / tool_result). Tool blocks
 *                   default-collapsed with a chevron; text blocks always render
 *                   their content inline (no chevron).
 *   - <ToolPair>  — an adjacent tool_use + tool_result pair (same `tool_use_id`)
 *                   rendered as a single collapsible visual unit. The chevron
 *                   toggles both. Expansion is handled by the parent Tree (it
 *                   re-renders the pair as two BlockRows when expanded).
 *
 * Collapse state is transient (Tree-level useState Map) — not persisted.
 */
import type { CSSProperties } from 'react'
import type { BlockMetadata, Node } from '../contract'
import { BlockMetadataSchema } from '../contract'

type BlockVisual = 'block-text' | 'block-tool-use' | 'block-tool-result'

function parseBlockMeta(n: Node): BlockMetadata | null {
  const parsed = BlockMetadataSchema.safeParse(n.metadata)
  return parsed.success ? parsed.data : null
}

function visualOf(meta: BlockMetadata): BlockVisual {
  const k = meta.payload.kind
  if (k === 'text') return 'block-text'
  if (k === 'tool_use') return 'block-tool-use'
  return 'block-tool-result'
}

function bulletFor(visual: BlockVisual): string {
  if (visual === 'block-text') return '·'
  if (visual === 'block-tool-use') return '⚙'
  return '↳'
}

/** Short identifier text shown when a tool block is collapsed. */
function toolSummary(meta: BlockMetadata): string {
  const p = meta.payload
  if (p.kind === 'tool_use') {
    const input = p.input
    let hint = ''
    if (input && typeof input === 'object') {
      // Prefer common path-like keys; fall back to the first stringy value.
      const obj = input as Record<string, unknown>
      const preferred = ['path', 'file_path', 'pattern', 'query', 'command']
      for (const key of preferred) {
        const v = obj[key]
        if (typeof v === 'string' && v.length > 0) {
          hint = v
          break
        }
      }
      if (!hint) {
        for (const v of Object.values(obj)) {
          if (typeof v === 'string' && v.length > 0) {
            hint = v
            break
          }
        }
      }
    } else if (typeof input === 'string') {
      hint = input
    }
    if (hint.length > 40) hint = hint.slice(0, 40) + '…'
    return hint ? `${p.toolName}(${hint})` : `${p.toolName}()`
  }
  if (p.kind === 'tool_result') {
    const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
    if (p.isError) return `→ error`
    const size = out.length
    return size > 0 ? `→ ${size}B` : `→ ok`
  }
  return p.text
}

/** Full expanded text for a Block — same shape as the v1.1 inline renderer. */
function fullBlockText(meta: BlockMetadata): string {
  const p = meta.payload
  if (p.kind === 'text') return p.text
  if (p.kind === 'tool_use') {
    const inputJson = JSON.stringify(p.input)
    return `${p.toolName}(${inputJson})`
  }
  const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
  return p.isError ? `error: ${out}` : out
}

interface BlockRowProps {
  node: Node
  depth: number
  collapsed: boolean
  /** Toggle this block's collapsed state. No-op for text blocks. */
  onToggle: () => void
  /** Pass-through DnD + ref hooks so behaviour matches non-Block rows. */
  draggable?: boolean
  attachRef?: (el: HTMLDivElement | null) => void
  dropClass?: string
  draggingClass?: string
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void
}

export function BlockRow({
  node,
  depth,
  collapsed,
  onToggle,
  draggable,
  attachRef,
  dropClass,
  draggingClass,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: BlockRowProps) {
  const meta = parseBlockMeta(node)
  if (!meta) {
    // Defensive: render as a plain row when metadata fails to parse.
    return (
      <div
        className="tree-node visual-block-text"
        data-visual="block-text"
        data-kind="block"
        data-node-id={node.id}
        style={{ paddingLeft: depth * 18 }}
      >
        <span className="bullet" aria-hidden>
          ·
        </span>
        <div className="content">{node.content}</div>
      </div>
    )
  }
  const visual = visualOf(meta)
  const isText = visual === 'block-text'
  const collapsedClass = !isText && collapsed ? 'collapsed' : ''
  const displayText = isText ? fullBlockText(meta) : collapsed ? toolSummary(meta) : fullBlockText(meta)
  const style: CSSProperties = { paddingLeft: depth * 18 }
  return (
    <div
      className={`tree-node visual-${visual} ${collapsedClass} ${dropClass ?? ''} ${draggingClass ?? ''}`
        .replace(/\s+/g, ' ')
        .trim()}
      data-visual={visual}
      data-kind="block"
      data-node-id={node.id}
      data-collapsed={!isText ? (collapsed ? 'true' : 'false') : undefined}
      style={style}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!isText && (
        <button
          type="button"
          className="chevron"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'expand' : 'collapse'}
          data-testid="block-chevron"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      )}
      <span className="bullet" aria-hidden>
        {bulletFor(visual)}
      </span>
      <div ref={attachRef} className="content">
        {displayText}
      </div>
    </div>
  )
}

interface ToolPairProps {
  toolUse: Node
  toolResult: Node
  depth: number
  /** Toggle the pair's collapsed state. Pair is always collapsed when shown
   *  through this component — expansion is handled by the parent re-rendering
   *  the pair as two separate BlockRows. */
  onToggle: () => void
}

/** Collapsed-state visual unit for a tool_use + tool_result pair. */
export function ToolPair({ toolUse, toolResult, depth, onToggle }: ToolPairProps) {
  const useMeta = parseBlockMeta(toolUse)
  const resMeta = parseBlockMeta(toolResult)
  const useSummary = useMeta ? toolSummary(useMeta) : toolUse.content
  const resSummary = resMeta ? toolSummary(resMeta) : toolResult.content
  return (
    <div
      className="tree-node visual-tool-pair collapsed"
      data-visual="tool-pair"
      data-kind="block"
      data-node-id={toolUse.id}
      data-pair-result-id={toolResult.id}
      data-collapsed="true"
      style={{ paddingLeft: depth * 18 }}
    >
      <button
        type="button"
        className="chevron"
        aria-expanded="false"
        aria-label="expand"
        data-testid="pair-chevron"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        ▸
      </button>
      <span className="bullet" aria-hidden>
        ⚙
      </span>
      <div className="content tool-pair-summary">
        <span className="tool-pair-use">{useSummary}</span>
        <span className="tool-pair-arrow"> {resSummary}</span>
      </div>
    </div>
  )
}
