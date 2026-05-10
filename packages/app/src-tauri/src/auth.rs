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

fn use_memory_backend() -> bool {
    std::env::var("CEDARPAD_KEYCHAIN_MEMORY").map(|v| v == "1").unwrap_or(false)
}

fn memory_key() -> String {
    format!("{SERVICE}:{ACCOUNT}")
}

/// Persist an API key in the OS keychain (or in-memory backend when
/// `CEDARPAD_KEYCHAIN_MEMORY=1`).
pub fn set_api_key(key: &str) -> Result<(), String> {
    if use_memory_backend() {
        let mut m = MEMORY_STORE.lock().map_err(|e| e.to_string())?;
        m.insert(memory_key(), key.to_string());
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}

/// Read the API key from the OS keychain (or memory backend).
/// Returns `Ok(None)` when no key has been set.
pub fn get_api_key() -> Result<Option<String>, String> {
    if use_memory_backend() {
        let m = MEMORY_STORE.lock().map_err(|e| e.to_string())?;
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

/// Remove the API key from the keychain. No-op when no key is present.
pub fn delete_api_key() -> Result<(), String> {
    if use_memory_backend() {
        let mut m = MEMORY_STORE.lock().map_err(|e| e.to_string())?;
        m.remove(&memory_key());
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
