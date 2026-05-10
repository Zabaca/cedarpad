import { useState, type FormEvent } from 'react'
import { authSetApiKey } from '../ipc'

interface Props {
  onSaved: () => void
}

/**
 * First-launch BYOK key entry screen. Shown when `auth_has_api_key`
 * returns false. The renderer sends the typed key directly to a Tauri
 * command (`auth_set_api_key`) which writes to the OS keychain and
 * pushes the key into the sidecar — the renderer never reads it back.
 */
export function ApiKeyPrompt({ onSaved }: Props) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = key.trim()
    if (!trimmed) {
      setError('Enter your Anthropic API key.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await authSetApiKey(trimmed)
      setKey('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app api-key-prompt" data-testid="api-key-prompt">
      <h2>Connect Claude</h2>
      <p>
        cedarpad uses your Anthropic API key (BYOK) to drive Claude Code. The key is
        stored in your OS keychain and never leaves this machine.
      </p>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label>
          <span>Anthropic API key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-..."
            autoFocus
            data-testid="api-key-input"
          />
        </label>
        <button type="submit" disabled={saving} data-testid="api-key-submit">
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </form>
    </div>
  )
}
