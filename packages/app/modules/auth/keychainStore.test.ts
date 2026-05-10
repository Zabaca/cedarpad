/**
 * Unit tests for the sidecar-side `keychainStore`.
 *
 * The keychainStore is a thin in-process cache for the Anthropic API key.
 * The OS keychain itself lives in the Tauri (Rust) shell — see
 * `src-tauri/src/auth.rs`. The sidecar receives the key from Rust over
 * the side-channel injection path (`auth.injectApiKey` NDJSON message)
 * and stores it here for the SDK runner to consume.
 *
 * The store is therefore an adapter, not a direct OS keychain wrapper:
 * its job is to (a) hold the current key, (b) report whether a key is
 * configured, (c) expose set/delete entry points that mirror the wire
 * verbs Rust pushes in.
 *
 * We TDD it lightly per CLAUDE.md §1/§2 — just enough to lock in the
 * round-trip semantics the SDK runner relies on.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createKeychainStore, type KeychainStore } from './keychainStore.ts'

let store: KeychainStore

beforeEach(() => {
  store = createKeychainStore()
})

describe('keychainStore', () => {
  it('reports no key on a fresh store', () => {
    expect(store.hasApiKey()).toBe(false)
    expect(store.getApiKey()).toBeNull()
  })

  it('round-trips set → get / has', () => {
    store.setApiKey('sk-ant-test')
    expect(store.hasApiKey()).toBe(true)
    expect(store.getApiKey()).toBe('sk-ant-test')
  })

  it('overwrites a previously-set key', () => {
    store.setApiKey('sk-ant-old')
    store.setApiKey('sk-ant-new')
    expect(store.getApiKey()).toBe('sk-ant-new')
  })

  it('clears state on deleteApiKey', () => {
    store.setApiKey('sk-ant-test')
    store.deleteApiKey()
    expect(store.hasApiKey()).toBe(false)
    expect(store.getApiKey()).toBeNull()
  })

  it('rejects empty/whitespace keys (treats them as absence)', () => {
    expect(() => store.setApiKey('')).toThrow(/empty/i)
    expect(() => store.setApiKey('   ')).toThrow(/empty/i)
    expect(store.hasApiKey()).toBe(false)
  })
})
