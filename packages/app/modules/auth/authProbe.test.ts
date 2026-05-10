/**
 * Unit tests for `authProbe.detect`.
 *
 * The probe answers a single question on launch: "what auth path can the
 * Claude Code SDK use right now?" Three modes:
 *
 *   - `subscription` — any of: `ANTHROPIC_API_KEY`,
 *     `CLAUDE_CODE_OAUTH_TOKEN`,
 *     `${CLAUDE_CONFIG_DIR ?? ~/.claude}/.credentials.json`, or the
 *     macOS Keychain item `Claude Code-credentials` is present. The SDK
 *     picks any of these up transparently.
 *   - `api-key`      — the user has previously stored a BYOK key in our
 *     own keychain (no subscription source present).
 *   - `none`         — none of the above; the renderer must show the
 *     AuthPrompt.
 *
 * The probe accepts injected seams (file checker, keychain, env reader,
 * macOS keychain content) so tests can drive every branch without
 * touching the real filesystem or keychain.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createKeychainStore, type KeychainStore } from './keychainStore.ts'
import { detectAuth, type AuthDetectDeps } from './authProbe.ts'

let keychain: KeychainStore

beforeEach(() => {
  keychain = createKeychainStore()
})

/**
 * Build a deps shim with the given subscription-file presence + content.
 * The default env reader returns no overrides; tests pass their own when
 * exercising `CEDARPAD_E2E_AUTH_MODE` or `CLAUDE_CONFIG_DIR`. The
 * `claudeCodeKeychain` field stands in for the macOS Keychain item that
 * the Rust shell pushes into the sidecar at startup; default is `null`
 * (no entry / non-macOS).
 */
function deps(opts: {
  credentialsFile?: { exists: boolean; content?: string }
  claudeCodeKeychain?: string | null
  env?: Record<string, string | undefined>
  homedir?: string
}): AuthDetectDeps {
  const env = opts.env ?? {}
  return {
    keychain,
    homedir: () => opts.homedir ?? '/home/test',
    readEnv: (k) => env[k],
    readCredentialsFile: () => {
      const f = opts.credentialsFile
      if (!f || !f.exists) return null
      return f.content ?? '{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":9999999999999}}'
    },
    readClaudeCodeKeychain: () => opts.claudeCodeKeychain ?? null,
  }
}

describe('authProbe.detectAuth', () => {
  it('returns "subscription" when ~/.claude/.credentials.json exists and is valid', () => {
    const result = detectAuth(deps({ credentialsFile: { exists: true } }))
    expect(result.mode).toBe('subscription')
  })

  it('honours CLAUDE_CONFIG_DIR when probing for the credentials file', () => {
    // The probe must look at `${CLAUDE_CONFIG_DIR}/.credentials.json` when
    // that env var is set (the SDK does the same). We test this by making
    // the probe's file-reader assert the path it's asked for.
    let askedPath: string | null = null
    const result = detectAuth({
      keychain,
      homedir: () => '/home/test',
      readEnv: (k) => (k === 'CLAUDE_CONFIG_DIR' ? '/custom/claude/dir' : undefined),
      readCredentialsFile: (path) => {
        askedPath = path
        return '{"claudeAiOauth":{"accessToken":"tok"}}'
      },
      readClaudeCodeKeychain: () => null,
    })
    expect(result.mode).toBe('subscription')
    expect(askedPath).toBe('/custom/claude/dir/.credentials.json')
  })

  it('falls back to ~/.claude/.credentials.json when CLAUDE_CONFIG_DIR is unset', () => {
    let askedPath: string | null = null
    detectAuth({
      keychain,
      homedir: () => '/home/test',
      readEnv: () => undefined,
      readCredentialsFile: (path) => {
        askedPath = path
        return null
      },
      readClaudeCodeKeychain: () => null,
    })
    expect(askedPath).toBe('/home/test/.claude/.credentials.json')
  })

  it('returns "api-key" when no credentials file but the keychain has a key', () => {
    keychain.setApiKey('sk-ant-stored')
    const result = detectAuth(deps({ credentialsFile: { exists: false } }))
    expect(result.mode).toBe('api-key')
  })

  it('returns "none" when neither path is available', () => {
    const result = detectAuth(deps({ credentialsFile: { exists: false } }))
    expect(result.mode).toBe('none')
  })

  it('prefers subscription over a stored api-key when both are present', () => {
    keychain.setApiKey('sk-ant-stored')
    const result = detectAuth(deps({ credentialsFile: { exists: true } }))
    // Personal-desktop default: a logged-in subscription wins. The user
    // can still delete the API key from the keychain explicitly.
    expect(result.mode).toBe('subscription')
  })

  it('treats a malformed credentials file as no subscription auth', () => {
    const result = detectAuth(
      deps({ credentialsFile: { exists: true, content: 'not-json{{' } }),
    )
    expect(result.mode).toBe('none')
  })

  it('treats a credentials file missing the claudeAiOauth block as no subscription auth', () => {
    const result = detectAuth(
      deps({ credentialsFile: { exists: true, content: '{"unrelated":true}' } }),
    )
    expect(result.mode).toBe('none')
  })

  it('falls back to api-key when the credentials file is malformed but a key is stored', () => {
    keychain.setApiKey('sk-ant-stored')
    const result = detectAuth(
      deps({ credentialsFile: { exists: true, content: '{{{' } }),
    )
    expect(result.mode).toBe('api-key')
  })

  it('honours CEDARPAD_E2E_AUTH_MODE override (subscription)', () => {
    // The override is the e2e seam: tests force a deterministic mode
    // regardless of host filesystem state.
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        env: { CEDARPAD_E2E_AUTH_MODE: 'subscription' },
      }),
    )
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/forced/i)
  })

  it('honours CEDARPAD_E2E_AUTH_MODE override (api-key)', () => {
    const result = detectAuth(
      deps({
        credentialsFile: { exists: true },
        env: { CEDARPAD_E2E_AUTH_MODE: 'api-key' },
      }),
    )
    expect(result.mode).toBe('api-key')
  })

  it('honours CEDARPAD_E2E_AUTH_MODE override (none)', () => {
    keychain.setApiKey('sk-ant-stored')
    const result = detectAuth(
      deps({
        credentialsFile: { exists: true },
        env: { CEDARPAD_E2E_AUTH_MODE: 'none' },
      }),
    )
    expect(result.mode).toBe('none')
  })

  it('ignores an unknown CEDARPAD_E2E_AUTH_MODE value', () => {
    keychain.setApiKey('sk-ant-stored')
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        env: { CEDARPAD_E2E_AUTH_MODE: 'garbage' },
      }),
    )
    // Falls through to real detection logic.
    expect(result.mode).toBe('api-key')
  })

  it('returns "subscription" when ANTHROPIC_API_KEY is set in the environment', () => {
    // The SDK uses ANTHROPIC_API_KEY directly when present — the user
    // already has working auth without anything cedarpad has to manage.
    // We classify this as `subscription` (no prompt needed) since
    // cedarpad doesn't need to set anything itself.
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        env: { ANTHROPIC_API_KEY: 'sk-ant-from-env' },
      }),
    )
    expect(result.mode).toBe('subscription')
  })

  it('returns "subscription" when CLAUDE_CODE_OAUTH_TOKEN is set in the environment', () => {
    // The SDK reads CLAUDE_CODE_OAUTH_TOKEN as a peer to the credentials
    // file / keychain — cedarpad needs to recognise it the same way so
    // we don't show the AuthPrompt to a user with working auth.
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
      }),
    )
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('returns "subscription" when only the macOS Claude Code-credentials keychain item is present', () => {
    // The bug this commit fixes: on modern macOS `claude /login` writes
    // only to the keychain, never to ~/.claude/.credentials.json. The
    // probe must accept the keychain content as proof of subscription
    // auth.
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        claudeCodeKeychain:
          '{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":9999999999999}}',
      }),
    )
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/keychain/i)
  })

  it('falls through to BYOK when the keychain content is malformed JSON', () => {
    // Defensive: a corrupt keychain item should not promote to
    // subscription. We fall through to the next precedence step (BYOK).
    keychain.setApiKey('sk-ant-stored')
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        claudeCodeKeychain: 'not-json{{',
      }),
    )
    expect(result.mode).toBe('api-key')
  })

  it('falls through to "none" when the keychain content lacks claudeAiOauth', () => {
    const result = detectAuth(
      deps({
        credentialsFile: { exists: false },
        claudeCodeKeychain: '{"unrelated":true}',
      }),
    )
    expect(result.mode).toBe('none')
  })

  it('precedence: ANTHROPIC_API_KEY beats CLAUDE_CODE_OAUTH_TOKEN beats credentials file beats keychain item beats BYOK', () => {
    // All four subscription sources are present plus a BYOK key. The
    // probe must pick the highest-precedence one and surface its
    // diagnostic detail. We verify each level by stripping the source
    // above it.
    keychain.setApiKey('sk-ant-stored')

    const baseOpts = {
      credentialsFile: {
        exists: true,
        content: '{"claudeAiOauth":{"accessToken":"file-tok"}}',
      },
      claudeCodeKeychain: '{"claudeAiOauth":{"accessToken":"kc-tok"}}',
    }

    // 1. ANTHROPIC_API_KEY wins
    let result = detectAuth(
      deps({
        ...baseOpts,
        env: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o' },
      }),
    )
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/ANTHROPIC_API_KEY/)

    // 2. CLAUDE_CODE_OAUTH_TOKEN wins over file + keychain
    result = detectAuth(
      deps({ ...baseOpts, env: { CLAUDE_CODE_OAUTH_TOKEN: 'o' } }),
    )
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)

    // 3. credentials file wins over keychain
    result = detectAuth(deps(baseOpts))
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/credentials file/)

    // 4. keychain wins over BYOK
    result = detectAuth(
      deps({ credentialsFile: { exists: false }, claudeCodeKeychain: baseOpts.claudeCodeKeychain }),
    )
    expect(result.mode).toBe('subscription')
    expect(result.detail).toMatch(/keychain/i)

    // 5. BYOK is last
    result = detectAuth(deps({ credentialsFile: { exists: false } }))
    expect(result.mode).toBe('api-key')
  })
})
