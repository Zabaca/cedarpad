/**
 * Sidecar-side cache of the Anthropic API key.
 *
 * The OS keychain (macOS Keychain / Linux Secret Service / Windows Credential
 * Manager) is owned by the Tauri shell — written via the `keyring` crate from
 * Rust. When the app starts (or the user enters a new key in the renderer),
 * Rust pushes the key into the sidecar over an `auth.injectApiKey` NDJSON
 * message. The sidecar parks it here so the SDK runner can read it
 * synchronously when it spawns the Claude Code SDK.
 *
 * The renderer never reads the key back from the sidecar. The only outbound
 * keychain RPCs from the renderer are `auth.hasApiKey` / `auth.setApiKey` /
 * `auth.deleteApiKey`, all of which round-trip via the Rust shell.
 *
 * This module is intentionally tiny — its value is the typed seam, not the
 * data structure.
 */

export interface KeychainStore {
  /** Cache the current API key. Throws on empty/whitespace input. */
  setApiKey(key: string): void
  /** Returns the cached key, or null if no key is configured. */
  getApiKey(): string | null
  hasApiKey(): boolean
  /** Drops the cached key. */
  deleteApiKey(): void
}

export function createKeychainStore(): KeychainStore {
  let current: string | null = null
  return {
    setApiKey(key) {
      if (typeof key !== 'string' || key.trim().length === 0) {
        throw new Error('keychainStore.setApiKey: key must be a non-empty string')
      }
      current = key
    },
    getApiKey() {
      return current
    },
    hasApiKey() {
      return current !== null
    },
    deleteApiKey() {
      current = null
    },
  }
}
