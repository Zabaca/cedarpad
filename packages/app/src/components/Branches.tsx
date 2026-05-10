/**
 * Branches container row (v1.1, ADR-0006).
 *
 * Renders a single `kind: 'branches'` Node as a clickable header with a
 * chevron + child count. Default collapsed; click toggles. The children
 * (Branches) are rendered by the parent `Tree.tsx` walker — this
 * component is purely the header surface.
 */
import type { Node } from '../contract'

interface Props {
  container: Node
  childCount: number
  expanded: boolean
  onToggle: (containerId: string) => void
  depth: number
}

export function BranchesHeader({ container, childCount, expanded, onToggle, depth }: Props) {
  const label = childCount === 1 ? '1 branch' : `${childCount} branches`
  return (
    <div
      className={`tree-node visual-branches branches-header ${expanded ? 'expanded' : 'collapsed'}`}
      data-visual="branches"
      data-kind="branches"
      data-node-id={container.id}
      data-branches-expanded={expanded ? 'true' : 'false'}
      style={{ paddingLeft: depth * 18 }}
    >
      <button
        type="button"
        className="branches-toggle"
        aria-label={expanded ? 'Collapse branches' : 'Expand branches'}
        aria-expanded={expanded}
        onClick={() => onToggle(container.id)}
      >
        <span className="branches-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="branches-label">{label}</span>
      </button>
    </div>
  )
}
