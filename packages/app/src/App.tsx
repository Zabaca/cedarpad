import { useEffect, useState, useCallback } from 'react'
import { call, isTauri, authHasApiKey } from './ipc'
import { Tree } from './components/Tree'
import { WorkspacePicker } from './components/WorkspacePicker'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { SearchPalette } from './components/SearchPalette'
import { ApiKeyPrompt } from './components/ApiKeyPrompt'
import type { WorkspaceSummary } from './contract'

// Workspace UI state. Persisted in localStorage so a relaunch restores the
// last hide-completed preference; per-workspace key so two repos don't share.
const HIDE_COMPLETED_KEY = (workspaceId: string) => `cedarpad.hideCompleted.${workspaceId}`

export function App() {
  const [active, setActive] = useState<WorkspaceSummary | null>(null)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [navigateRequest, setNavigateRequest] = useState<{ id: string; nonce: number } | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)
  const [hideCompleted, setHideCompleted] = useState(false)
  // BYOK: when null, we haven't probed the keychain yet; false = no key
  // configured (show ApiKeyPrompt); true = key present (proceed).
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)

  // Persist + apply a zoom-pointer change for the current workspace. The
  // sidecar is the source of truth for activeNodeId; we update the local
  // summary optimistically with the response so the Tree re-renders.
  const persistActiveNode = useCallback(
    async (workspaceId: string, activeNodeId: string | null) => {
      try {
        const ws = await call('workspace.setActiveNode', { id: workspaceId, activeNodeId })
        setActive(ws)
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e))
      }
    },
    [],
  )

  // On launch: probe keychain first, then restore last active workspace.
  // The app refuses to surface workspace UI until a key is configured —
  // per slice 3 acceptance criterion ("App refuses to start a Thread
  // without a key configured").
  useEffect(() => {
    if (!isTauri()) {
      setHasApiKey(true) // browser dev mode skips the key flow
      setBooted(true)
      return
    }
    void (async () => {
      try {
        const present = await authHasApiKey()
        setHasApiKey(present)
        if (present) {
          const recents = await call('workspace.recent', {})
          if (recents.length > 0) {
            const target = recents[0]!
            const ws = await call('workspace.switch', { id: target.id })
            setActive(ws)
            // Slice 4: any Turn left in `state: 'streaming'` from a prior
            // run is necessarily orphaned (the sidecar is fresh). Mark
            // them `interrupted` so the renderer can show them as crashed
            // rather than silently leaving them looking active.
            try {
              await call('thread.scanInterrupted', { workspaceId: ws.id })
            } catch {
              // Best-effort — a failure here just means streaming turns
              // keep their old state until a future scan succeeds.
            }
          }
        }
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e))
      } finally {
        setBooted(true)
      }
    })()
  }, [])

  // Re-probe + load workspace after the user enters a key.
  const handleKeySaved = useCallback(async () => {
    setHasApiKey(true)
    try {
      const recents = await call('workspace.recent', {})
      if (recents.length > 0) {
        const target = recents[0]!
        const ws = await call('workspace.switch', { id: target.id })
        setActive(ws)
        try {
          await call('thread.scanInterrupted', { workspaceId: ws.id })
        } catch {
          /* best-effort */
        }
      }
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Restore per-workspace hide-completed preference whenever the active
  // workspace changes.
  useEffect(() => {
    if (!active) return
    try {
      const raw = window.localStorage.getItem(HIDE_COMPLETED_KEY(active.id))
      setHideCompleted(raw === '1')
    } catch {
      setHideCompleted(false)
    }
  }, [active])

  const toggleHideCompleted = useCallback(() => {
    setHideCompleted((cur) => {
      const next = !cur
      if (active) {
        try {
          window.localStorage.setItem(HIDE_COMPLETED_KEY(active.id), next ? '1' : '0')
        } catch {
          // Best-effort persistence; in-memory state still applies.
        }
      }
      return next
    })
  }, [active])

  // Cmd+P → toggle switcher, Cmd+K → toggle search palette, Cmd+Shift+H
  // → toggle hide-completed. Only in Tauri to avoid clobbering native
  // browser bindings during dev.
  useEffect(() => {
    if (!isTauri()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'p' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setShowSwitcher((s) => !s)
      }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setShowSearch((s) => !s)
      }
      if (e.key.toLowerCase() === 'h' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggleHideCompleted()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleHideCompleted])

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

  if (hasApiKey === false) {
    return <ApiKeyPrompt onSaved={() => void handleKeySaved()} />
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
            <div className="toolbar-right">
              <button
                type="button"
                className="toggle-hide-completed"
                onClick={toggleHideCompleted}
                aria-pressed={hideCompleted}
                data-testid="toggle-hide-completed"
              >
                {hideCompleted ? 'Show completed' : 'Hide completed'}
              </button>
              <div className="hint">Cmd+P · switch · Cmd+K · search · Cmd+Shift+H · hide done · Cmd+Enter · complete · Cmd+. zoom in · Cmd+, zoom out</div>
            </div>
          </div>
          <Tree
            workspaceId={active.id}
            hideCompleted={hideCompleted}
            activeNodeId={active.activeNodeId}
            workspaceName={active.displayName}
            repoPath={active.repoPath}
            onZoomTo={(nodeId) => void persistActiveNode(active.id, nodeId)}
            navigateRequest={navigateRequest}
          />
        </>
      )}
      {showSwitcher && (
        <WorkspaceSwitcher
          activeId={active?.id ?? null}
          onSelect={handleSwitched}
          onClose={() => setShowSwitcher(false)}
        />
      )}
      {showSearch && active && (
        <SearchPalette
          workspaceId={active.id}
          onSelect={(id) => {
            setNavigateRequest({ id, nonce: Date.now() })
            setShowSearch(false)
          }}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  )
}
