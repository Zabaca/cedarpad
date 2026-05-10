//! BYOK Anthropic API key storage (slice 3).
//!
//! The OS keychain is owned by this Rust shell — the renderer never reads
//! the key back, and the sidecar receives it only via the
//! `auth.injectApiKey` NDJSON push from this process.
//!
//! Backend: the `keyring` crate (v3), wrapping the platform's native
//! credential store (macOS Keychain, Linux Secret Service / kwallet,
//! Windows Credential Manager).
//!
//! Test mode: when `CEDARPAD_KEYCHAIN_MEMORY=1` is set, an in-memory
//! HashMap stands in for the OS keychain. This is what the WebView e2e
//! harness uses so tests don't pollute the developer's real keychain.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

const SERVICE: &str = "cedarpad";
const ACCOUNT: &str = "anthropic-api-key";

static MEMORY_STORE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Sentinel flag in the memory store: once the user explicitly deletes
/// the key, we stop re-seeding from `CEDARPAD_E2E_DEFAULT_KEY`. Without
/// this the auth e2e spec (which deletes + reloads to verify the prompt
/// shows up) would see the default re-populate and never see the
/// prompt.
const DELETED_FLAG: &str = "__cedarpad_e2e_deleted__";

fn use_memory_backend() -> bool {
    std::env::var("CEDARPAD_KEYCHAIN_MEMORY").map(|v| v == "1").unwrap_or(false)
}

fn memory_key() -> String {
    format!("{SERVICE}:{ACCOUNT}")
}

/// E2E convenience: when memory-backed and no key is set, auto-populate
/// from `CEDARPAD_E2E_DEFAULT_KEY` so the existing specs that don't
/// exercise the auth flow don't have to type a key first. The auth
/// e2e spec explicitly clears the key and re-runs the flow — once the
/// `DELETED_FLAG` is set we stop re-seeding for the rest of the
/// process lifetime.
fn ensure_default_key(map: &mut HashMap<String, String>) {
    if !use_memory_backend() {
        return;
    }
    if map.contains_key(&memory_key()) {
        return;
    }
    if map.contains_key(DELETED_FLAG) {
        return;
    }
    if let Ok(default_key) = std::env::var("CEDARPAD_E2E_DEFAULT_KEY") {
        if !default_key.is_empty() {
            map.insert(memory_key(), default_key);
        }
    }
}

/// Persist an API key in the OS keychain (or in-memory backend when
/// `CEDARPAD_KEYCHAIN_MEMORY=1`).
pub fn set_api_key(key: &str) -> Result<(), String> {
    if use_memory_backend() {
        let mut m = MEMORY_STORE.lock().map_err(|e| e.to_string())?;
        m.insert(memory_key(), key.to_string());
        m.remove(DELETED_FLAG);
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}

/// Read the API key from the OS keychain (or memory backend).
/// Returns `Ok(None)` when no key has been set.
pub fn get_api_key() -> Result<Option<String>, String> {
    if use_memory_backend() {
        let mut m = MEMORY_STORE.lock().map_err(|e| e.to_string())?;
        ensure_default_key(&mut m);
        return Ok(m.get(&memory_key()).cloned());
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Returns true when a key is configured.
pub fn has_api_key() -> Result<bool, String> {
    Ok(get_api_key()?.is_some())
}

/// Read the macOS Keychain item `Claude Code-credentials` (account =
/// `$USER`). Returns the raw stored string (the SDK writes JSON of the
/// shape `{ "claudeAiOauth": { "accessToken": "...", ... } }`) or
/// `None` when no entry exists. Errors other than `NoEntry` are logged
/// and squashed to `None` — the probe stays cheap and side-effect-free.
///
/// On non-macOS targets this is a no-op that returns `None`. We
/// deliberately don't expose the SDK's keychain reader on Linux /
/// Windows: those platforms don't have a Claude-Code-managed keychain
/// entry, and probing for one would mostly produce noise.
///
/// Reading is done from this Rust shell rather than the bun sidecar so
/// the macOS ACL prompt ("cedarpad wants to access Claude Code in your
/// keychain — Allow / Always Allow / Deny") shows under cedarpad's
/// signed identity, the same one the BYOK keychain item is stored
/// under. One ACL grant covers reads of both items.
#[cfg(target_os = "macos")]
pub fn read_claude_code_credentials() -> Option<String> {
    let username = match std::env::var("USER") {
        Ok(u) if !u.is_empty() => u,
        _ => return None,
    };
    let entry = match keyring::Entry::new("Claude Code-credentials", &username) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[cedarpad] Claude Code keychain entry construction failed: {e}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(s) => Some(s),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[cedarpad] Claude Code keychain read failed: {e}");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_claude_code_credentials() -> Option<String> {
    None
}

/// Remove the API key from the keychain. No-op when no key is present.
pub fn delete_api_key() -> Result<(), String> {
    if use_memory_backend() {
        let mut m = MEMORY_STORE.lock().map_err(|e| e.to_string())?;
        m.remove(&memory_key());
        // Suppress the default-key re-seed for the rest of this process.
        m.insert(DELETED_FLAG.to_string(), String::new());
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
