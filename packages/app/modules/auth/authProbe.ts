/**
 * Authoritative auth-state probe for the sidecar.
 *
 * Answers a single question on launch: "what auth path can the Claude
 * Code SDK use right now?" Three modes:
 *
 *   - `subscription` — the user is signed in with Claude Code (Pro/Max
 *     OAuth). The Claude Agent SDK transparently picks up its
 *     `~/.claude/.credentials.json` (or whatever `CLAUDE_CONFIG_DIR`
 *     points at) when no `ANTHROPIC_API_KEY` env var is set, so cedarpad
 *     does NOT need to inject anything. We also classify a pre-set
 *     `ANTHROPIC_API_KEY` env var as `subscription` — the SDK already
 *     has working auth without our help.
 *   - `api-key`      — no subscription file, but the user previously
 *     stored a BYOK key in our own keychain. The runner still injects
 *     this via `env.ANTHROPIC_API_KEY` when invoking the SDK.
 *   - `none`         — neither path is configured. The renderer must show
 *     the AuthPrompt to let the user sign in or paste a key.
 *
 * The probe accepts injected seams (file checker, keychain, env reader,
 * homedir) so unit tests can drive every branch without touching the
 * real filesystem or keychain. `CEDARPAD_E2E_AUTH_MODE` lets the e2e
 * harness force a deterministic mode regardless of host state.
 *
 * Source-of-truth for the SDK's credential file path: at the time of
 * writing (claude-agent-sdk@0.2.138, May 2026) the SDK reads
 * `${CLAUDE_CONFIG_DIR ?? <homedir>/.claude}/.credentials.json`. On
 * macOS it additionally falls back to the keychain item
 * `Claude Code-credentials` if neither the env var nor the file is
 * present, but we don't probe that explicitly — if the file isn't there
 * the user can still get the SDK to run via `claude /login` (which
 * writes the file) or via BYOK.
 */
import type { KeychainStore } from './keychainStore.ts'

export type AuthMode = 'subscription' | 'api-key' | 'none'

export interface AuthDetectResult {
  mode: AuthMode
  /** Human-readable hint useful for diagnostics. Not shown to users directly. */
  detail?: string
}

export interface AuthDetectDeps {
  keychain: KeychainStore
  /** Returns the path the credentials file would live at, then its content (or null when absent / unreadable). */
  readCredentialsFile: (path: string) => string | null
  readEnv: (name: string) => string | undefined
  homedir: () => string
}

const E2E_OVERRIDE_VALUES: Record<string, AuthMode> = {
  subscription: 'subscription',
  'api-key': 'api-key',
  none: 'none',
}

function credentialsPath(deps: AuthDetectDeps): string {
  const override = deps.readEnv('CLAUDE_CONFIG_DIR')
  const base = override ?? `${deps.homedir()}/.claude`
  return `${base}/.credentials.json`
}

function looksLikeOauthCredentials(content: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const obj = parsed as Record<string, unknown>
  const oauth = obj.claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return false
  // Cheapest valid-shape check — any access token is enough; refresh +
  // expiry are the SDK's job to honour.
  return typeof (oauth as { accessToken?: unknown }).accessToken === 'string'
}

export function detectAuth(deps: AuthDetectDeps): AuthDetectResult {
  // E2E harness override: trust the env var when it names a known mode.
  // Lets `auth-detect.spec.ts` exercise all three branches without
  // depending on host filesystem state.
  const forced = deps.readEnv('CEDARPAD_E2E_AUTH_MODE')
  if (forced && Object.prototype.hasOwnProperty.call(E2E_OVERRIDE_VALUES, forced)) {
    return { mode: E2E_OVERRIDE_VALUES[forced]!, detail: 'forced via CEDARPAD_E2E_AUTH_MODE' }
  }

  // The SDK uses `ANTHROPIC_API_KEY` directly when set, bypassing both
  // the credentials file and the keychain. cedarpad has nothing to inject
  // on top, so we treat this as a working-auth state and skip the
  // prompt.
  const envKey = deps.readEnv('ANTHROPIC_API_KEY')
  if (envKey && envKey.trim().length > 0) {
    return { mode: 'subscription', detail: 'ANTHROPIC_API_KEY in environment' }
  }

  const path = credentialsPath(deps)
  const content = deps.readCredentialsFile(path)
  if (content && looksLikeOauthCredentials(content)) {
    return { mode: 'subscription', detail: `credentials file at ${path}` }
  }

  if (deps.keychain.hasApiKey()) {
    return { mode: 'api-key', detail: 'BYOK key in cedarpad keychain' }
  }

  return { mode: 'none' }
}
