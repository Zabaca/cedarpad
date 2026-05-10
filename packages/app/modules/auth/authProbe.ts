/**
 * Authoritative auth-state probe for the sidecar.
 *
 * Answers a single question on launch: "what auth path can the Claude
 * Code SDK use right now?" Three modes:
 *
 *   - `subscription` — the user is signed in with Claude Code (Pro/Max
 *     OAuth) or has `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`
 *     pre-set in the environment. The Claude Agent SDK transparently
 *     picks any of these up; cedarpad does NOT need to inject anything.
 *   - `api-key`      — no subscription path, but the user previously
 *     stored a BYOK key in our own keychain. The runner still injects
 *     this via `env.ANTHROPIC_API_KEY` when invoking the SDK.
 *   - `none`         — neither path is configured. The renderer must show
 *     the AuthPrompt to let the user sign in or paste a key.
 *
 * The probe accepts injected seams (file checker, keychain, env reader,
 * homedir, Claude Code keychain reader) so unit tests can drive every
 * branch without touching the real filesystem or OS keychain.
 * `CEDARPAD_E2E_AUTH_MODE` lets the e2e harness force a deterministic
 * mode regardless of host state.
 *
 * Subscription detection precedence (must match the SDK's internal
 * order):
 *   1. `ANTHROPIC_API_KEY` env var
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env var
 *   3. `${CLAUDE_CONFIG_DIR ?? <homedir>/.claude}/.credentials.json`
 *      containing `claudeAiOauth.accessToken`
 *   4. macOS Keychain item `Claude Code-credentials` (account =
 *      `$USER`) containing `claudeAiOauth.accessToken`. On modern
 *      macOS, `claude /login` writes *only* to this keychain item —
 *      no credentials file is created — so without this step the
 *      probe falls through to `none` even when the user is signed in.
 *      The Rust shell owns the keychain read (same binary as the BYOK
 *      store, so one ACL grant covers both items) and pushes the raw
 *      JSON into the sidecar; the seam below just consults that cache.
 *
 * Source-of-truth for SDK behaviour: claude-agent-sdk@0.2.138 (May
 * 2026) reads, in order, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
 * `${CLAUDE_CONFIG_DIR ?? ~/.claude}/.credentials.json`, then on macOS
 * the keychain item `Claude Code-credentials`.
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
  /**
   * Returns the raw contents of the macOS Keychain item
   * `Claude Code-credentials`, or null when absent / not on macOS /
   * not yet pushed in by the Rust shell.
   */
  readClaudeCodeKeychain: () => string | null
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

  // The SDK uses `ANTHROPIC_API_KEY` directly when set, bypassing every
  // other source. cedarpad has nothing to inject on top, so we treat
  // this as a working-auth state and skip the prompt.
  const envKey = deps.readEnv('ANTHROPIC_API_KEY')
  if (envKey && envKey.trim().length > 0) {
    return { mode: 'subscription', detail: 'ANTHROPIC_API_KEY in environment' }
  }

  // Same story for `CLAUDE_CODE_OAUTH_TOKEN`: the SDK honours it
  // directly. We don't read it for any other purpose; it's a pure
  // pass-through.
  const envOauth = deps.readEnv('CLAUDE_CODE_OAUTH_TOKEN')
  if (envOauth && envOauth.trim().length > 0) {
    return { mode: 'subscription', detail: 'CLAUDE_CODE_OAUTH_TOKEN in environment' }
  }

  const path = credentialsPath(deps)
  const content = deps.readCredentialsFile(path)
  if (content && looksLikeOauthCredentials(content)) {
    return { mode: 'subscription', detail: `credentials file at ${path}` }
  }

  // macOS Keychain fallback. On modern macOS `claude /login` writes
  // only here, so a missing credentials file does not mean the user is
  // signed out.
  const keychainContent = deps.readClaudeCodeKeychain()
  if (keychainContent && looksLikeOauthCredentials(keychainContent)) {
    return { mode: 'subscription', detail: 'Claude Code-credentials keychain item' }
  }

  if (deps.keychain.hasApiKey()) {
    return { mode: 'api-key', detail: 'BYOK key in cedarpad keychain' }
  }

  return { mode: 'none' }
}
