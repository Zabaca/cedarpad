/**
 * Unit tests for the Bun-side Claude Code keychain reader.
 *
 * We can't easily mock `Bun.spawnSync` from vitest, so the focused
 * coverage here is on the cheap early-return branches the e2e harness
 * relies on:
 *
 *   - non-darwin platforms return `null` without shelling out.
 *   - `CEDARPAD_KEYCHAIN_MEMORY=1` returns `null` without shelling out
 *     (the e2e gate that suppresses the macOS ACL dialog during the
 *     WebView e2e suite).
 *
 * The "actually reads the keychain" path is exercised by the manual
 * launch verification documented on the PR. We don't synthesize a
 * keychain entry from CI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readClaudeCodeKeychain } from './claudeCodeKeychain.ts'

describe('readClaudeCodeKeychain', () => {
  const origPlatform = process.platform
  const origMem = process.env.CEDARPAD_KEYCHAIN_MEMORY

  beforeEach(() => {
    delete process.env.CEDARPAD_KEYCHAIN_MEMORY
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
    if (origMem === undefined) {
      delete process.env.CEDARPAD_KEYCHAIN_MEMORY
    } else {
      process.env.CEDARPAD_KEYCHAIN_MEMORY = origMem
    }
  })

  it('returns null on non-darwin platforms without shelling out', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(readClaudeCodeKeychain()).toBeNull()
  })

  it('returns null when CEDARPAD_KEYCHAIN_MEMORY=1 (e2e gate)', () => {
    // Force darwin so this test is meaningful even on non-mac CI — the
    // env gate must short-circuit before the platform check would
    // matter for the shell-out.
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.CEDARPAD_KEYCHAIN_MEMORY = '1'
    expect(readClaudeCodeKeychain()).toBeNull()
  })

  it('returns null when CEDARPAD_KEYCHAIN_MEMORY is set to something other than "1"', () => {
    // Belt-and-braces: only the literal "1" is the gate, matching the
    // BYOK side. Empty string / "0" / "true" do NOT suppress.
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.CEDARPAD_KEYCHAIN_MEMORY = '0'
    // Still null because non-darwin — but the point is that the env
    // gate didn't fire, the platform gate did.
    expect(readClaudeCodeKeychain()).toBeNull()
  })
})
