import { useEffect, useState } from 'react'
import { call } from '../ipc'
import type { WorkspaceSummary } from '../contract'

interface Props {
  activeId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

export function WorkspaceSwitcher({ activeId, onSelect, onClose }: Props) {
  const [items, setItems] = useState<WorkspaceSummary[]>([])
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    void call('workspace.recent', {}).then((rows) => {
      // Filter out the active one — switching to active is a no-op
      const filtered = activeId ? rows.filter((r) => r.id !== activeId) : rows
      setItems(filtered)
    })
  }, [activeId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => Math.min(s + 1, items.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => Math.max(s - 1, 0))
      }
      if (e.key === 'Enter' && items[selected]) {
        onSelect(items[selected].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, selected, onClose, onSelect])

  return (
    <div className="switcher-overlay" onClick={onClose}>
      <div className="switcher" onClick={(e) => e.stopPropagation()}>
        <div className="switcher-list">
          {items.length === 0 && <div className="switcher-item">No other workspaces yet.</div>}
          {items.map((w, i) => (
            <div
              key={w.id}
              className={`switcher-item ${i === selected ? 'selected' : ''}`}
              onClick={() => onSelect(w.id)}
              onMouseEnter={() => setSelected(i)}
            >
              <div>{w.displayName}</div>
              <div className="path">{w.repoPath}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
