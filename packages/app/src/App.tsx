import { useEffect, useState, useCallback } from 'react'
import { call, isTauri } from './ipc'
import { Tree } from './components/Tree'
import { WorkspacePicker } from './components/WorkspacePicker'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import type { WorkspaceSummary } from './contract'

export function App() {
  const [active, setActive] = useState<WorkspaceSummary | null>(null)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)

  // On launch, restore last active workspace from sidecar.
  useEffect(() => {
    if (!isTauri()) {
      setBooted(true)
      return
    }
    void (async () => {
      try {
        const recents = await call('workspace.recent', {})
        if (recents.length > 0) {
          const target = recents[0]!
          const ws = await call('workspace.switch', { id: target.id })
          setActive(ws)
        }
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e))
      } finally {
        setBooted(true)
      }
    })()
  }, [])

  // Cmd+P → toggle switcher (only in Tauri to avoid clobbering print).
  useEffect(() => {
    if (!isTauri()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'p' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setShowSwitcher((s) => !s)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handlePicked = useCallback(async (repoPath: string) => {
    try {
      const ws = await call('workspace.open', { repoPath })
      setActive(ws)
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const handleSwitched = useCallback(async (id: string) => {
    try {
      const ws = await call('workspace.switch', { id })
      setActive(ws)
      setShowSwitcher(false)
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  if (!booted) return <div className="app">Loading…</div>

  if (bootError) {
    return (
      <div className="app">
        <h2>Could not start</h2>
        <pre>{bootError}</pre>
      </div>
    )
  }

  return (
    <div className="app">
      {!active ? (
        <WorkspacePicker onPicked={handlePicked} />
      ) : (
        <>
          <div className="toolbar">
            <div>
              <div className="name">{active.displayName}</div>
              <div className="hint">{active.repoPath}</div>
            </div>
            <div className="hint">Cmd+P · switch workspace</div>
          </div>
          <Tree workspaceId={active.id} />
        </>
      )}
      {showSwitcher && (
        <WorkspaceSwitcher
          activeId={active?.id ?? null}
          onSelect={handleSwitched}
          onClose={() => setShowSwitcher(false)}
        />
      )}
    </div>
  )
}
