import { useEffect, useRef, useState } from 'react'
import { call } from '../ipc'
import type { Node } from '../contract'

interface Props {
  workspaceId: string
  onSelect: (id: string) => void
  onClose: () => void
}

interface Result {
  node: Node
  ancestorPath: string
}

/**
 * Build a short ancestor path ("Root > Parent") for each result. We fetch the
 * full set of nodes once via outline.getChildren walk and look up ancestors
 * locally. For slice 8 sizes (workspace-scoped, Workflowy-style), this is
 * cheap enough to do per-open; revisit if latency shows up.
 */
async function loadAncestors(workspaceId: string): Promise<Map<string, Node>> {
  const map = new Map<string, Node>()
  const queue: (string | null)[] = [null]
  while (queue.length) {
    const parent = queue.shift()!
    const children = await call('outline.getChildren', { workspaceId, parentId: parent })
    for (const c of children) {
      map.set(c.id, c)
      queue.push(c.id)
    }
  }
  return map
}

function buildAncestorPath(node: Node, byId: Map<string, Node>): string {
  const parts: string[] = []
  let cursor: string | null = node.parentId
  let guard = 0
  while (cursor !== null && guard++ < 20) {
    const p = byId.get(cursor)
    if (!p) break
    const text = (p.content ?? '').trim()
    parts.unshift(text.length === 0 ? '(empty)' : text.slice(0, 40))
    cursor = p.parentId
  }
  return parts.join(' › ')
}

/**
 * Escape user input so FTS5 treats the query as a phrase rather than parsing
 * operators (parens, AND/OR, column filters, etc.). Wrapping each whitespace-
 * separated term in double quotes gives prefix-style matching across all
 * tokens without surprising errors on typed parens or quotes.
 */
function toFtsQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ')
}

export function SearchPalette({ workspaceId, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const ancestorsRef = useRef<Map<string, Node> | null>(null)

  // Snapshot ancestors once on open. Tree edits during an open palette are
  // rare — refresh on next open.
  useEffect(() => {
    void loadAncestors(workspaceId).then((m) => {
      ancestorsRef.current = m
    })
  }, [workspaceId])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounce-light: query libSQL on every keystroke. FTS5 is fast and the
  // payload stays inside the binary. Keep it simple until profiling says no.
  useEffect(() => {
    let cancelled = false
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setSelected(0)
      return
    }
    const ftsQuery = toFtsQuery(trimmed)
    void (async () => {
      try {
        const hits = await call('outline.search', { workspaceId, query: ftsQuery })
        if (cancelled) return
        const byId = ancestorsRef.current
        const mapped: Result[] = hits.map((node) => ({
          node,
          ancestorPath: byId ? buildAncestorPath(node, byId) : '',
        }))
        setResults(mapped)
        setSelected(0)
      } catch {
        if (!cancelled) {
          setResults([])
          setSelected(0)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [query, workspaceId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => Math.min(s + 1, Math.max(results.length - 1, 0)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => Math.max(s - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        const r = results[selected]
        if (r) {
          e.preventDefault()
          onSelect(r.node.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, selected, onClose, onSelect])

  return (
    <div className="switcher-overlay" onClick={onClose}>
      <div className="switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Search nodes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="switcher-list">
          {query.trim().length === 0 && (
            <div className="switcher-item">Type to search across this workspace.</div>
          )}
          {query.trim().length > 0 && results.length === 0 && (
            <div className="switcher-item">No matches.</div>
          )}
          {results.map((r, i) => {
            const text = r.node.content.trim()
            return (
              <div
                key={r.node.id}
                data-result-id={r.node.id}
                className={`switcher-item ${i === selected ? 'selected' : ''}`}
                onClick={() => onSelect(r.node.id)}
                onMouseEnter={() => setSelected(i)}
              >
                <div>{text.length === 0 ? '(empty)' : text}</div>
                {r.ancestorPath && <div className="path">{r.ancestorPath}</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
