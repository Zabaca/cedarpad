import { useState, type FormEvent } from 'react'
import { authSetApiKey } from '../ipc'

interface Props {
  onSaved: () => void
}

/**
 * Auth setup screen shown when neither a Claude Code subscription login
 * nor a BYOK key is detected. Subscription is the primary path —
 * cedarpad is a personal desktop tool that runs on the user's own
 * subscription whenever possible. BYOK stays available as a secondary
 * fallback for users who'd rather pay per token.
 *
 * The subscription side has no UI button: cedarpad has no OAuth flow of
 * its own. The user runs `claude /login` in a terminal, which writes
 * `~/.claude/.credentials.json`. On the next relaunch the auth probe
 * picks it up and skips this screen entirely. We could autoreload here,
 * but a manual relaunch is the friendlier story (the user knows when
 * they're done).
 *
 * (Was `ApiKeyPrompt` in slice 3 — renamed in the post-merge fix that
 * made subscription auth the default.)
 */
export function AuthPrompt({ onSaved }: Props) {
  const [showApiKeyForm, setShowApiKeyForm] = useState(false)
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
    <div className="app auth-prompt" data-testid="auth-prompt">
      <h2>Connect Claude</h2>

      <section className="auth-section auth-subscription">
        <h3>Sign in with your Claude subscription</h3>
        <p>
          cedarpad uses your Claude Code login (Pro or Max). In a terminal, run:
        </p>
        <pre>claude /login</pre>
        <p>
          When you&rsquo;re signed in, relaunch cedarpad and this screen goes away.
        </p>
      </section>

      <section className="auth-section auth-api-key">
        {!showApiKeyForm ? (
          <button
            type="button"
            className="auth-toggle-api-key"
            onClick={() => setShowApiKeyForm(true)}
            data-testid="auth-show-api-key"
          >
            Use an API key instead
          </button>
        ) : (
          <>
            <h3>Use an Anthropic API key (BYOK)</h3>
            <p>
              The key is stored in your OS keychain and never leaves this machine.
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
          </>
        )}
      </section>
    </div>
  )
}
