import { useCallback } from 'react'

interface Props {
  onPicked: (repoPath: string) => void
}

export function WorkspacePicker({ onPicked }: Props) {
  const handle = useCallback(async () => {
    try {
      const dialog = await import('@tauri-apps/plugin-dialog')
      const picked = await dialog.open({ directory: true, multiple: false, title: 'Pick a repo' })
      if (typeof picked === 'string') {
        onPicked(picked)
      }
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Failed to open dialog: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [onPicked])

  return (
    <div className="workspace-picker">
      <h2>Welcome to cedarpad</h2>
      <p>Pick a local repo to use as your workspace.</p>
      <button onClick={handle}>Pick a repo…</button>
    </div>
  )
}
