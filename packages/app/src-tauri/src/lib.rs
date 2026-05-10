mod auth;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use once_cell::sync::OnceCell;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// Spawned bun sidecar — owns its stdin and a registry of pending requests.
struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

static SIDECAR: OnceCell<Arc<Sidecar>> = OnceCell::new();

fn next_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

async fn invoke_sidecar(method: &str, params: Value) -> Result<Value, String> {
    let sidecar = SIDECAR.get().ok_or("sidecar not started")?.clone();
    let id = next_id();
    let (tx, rx) = oneshot::channel();
    sidecar.pending.lock().await.insert(id.clone(), tx);

    let req = serde_json::json!({ "id": id, "method": method, "params": params });
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
    {
        let mut stdin = sidecar.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
    }
    let resp = rx.await.map_err(|e| e.to_string())?;
    if resp.get("kind").and_then(|v| v.as_str()) == Some("ok") {
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(resp
            .get("error")
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown sidecar error".into()))
    }
}

/// Fire-and-forget push into the sidecar (no response awaited). Used for
/// the `auth.injectApiKey` / `auth.clearApiKey` server-internal channel —
/// the sidecar acks but we don't need to block on it.
async fn push_sidecar(method: &str, params: Value) -> Result<(), String> {
    let sidecar = SIDECAR.get().ok_or("sidecar not started")?.clone();
    let id = format!("push-{}", next_id());
    let req = serde_json::json!({ "id": id, "method": method, "params": params });
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
    let mut stdin = sidecar.stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

async fn start_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    // In dev we run from `bun src-sidecar/src/server.ts`; in release we ship the
    // bundled JS at resource_dir/sidecar/server.js. Prefer the bundled path if
    // it exists, fall back to `bun run src-sidecar/src/server.ts`.
    let bundled = resource_dir.join("sidecar/server.js");
    let mut cmd = if bundled.exists() {
        let mut c = Command::new("bun");
        c.arg("run").arg(bundled);
        c
    } else {
        let dev_path = std::env::current_dir()
            .ok()
            .map(|p| p.join("../src-sidecar/src/server.ts"))
            .unwrap_or_else(|| std::path::PathBuf::from("src-sidecar/src/server.ts"));
        let mut c = Command::new("bun");
        c.arg("run").arg(dev_path);
        c
    };

    let mut child: Child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdin = child.stdin.take().ok_or("no stdin on sidecar")?;
    let stdout = child.stdout.take().ok_or("no stdout on sidecar")?;

    let sidecar = Arc::new(Sidecar {
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
    });
    SIDECAR.set(sidecar.clone()).map_err(|_| "sidecar already started")?;

    // Read NDJSON responses on stdout, route by id.
    //
    // Three frame kinds:
    //   - `ok` / `err`  → resolve the pending oneshot for this id.
    //   - `stream`      → forward to the renderer as a Tauri event on
    //                     channel `rpc:stream:<id>`. The renderer wires
    //                     a one-shot listener per streaming `invoke('rpc',
    //                     ...)` call.
    let sidecar2 = sidecar.clone();
    let app_handle_for_stream: tauri::AppHandle = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                        let kind = parsed.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                        let id_opt = parsed.get("id").and_then(|v| v.as_str()).map(String::from);
                        if kind == "stream" {
                            if let Some(id) = id_opt {
                                let event_payload =
                                    parsed.get("event").cloned().unwrap_or(Value::Null);
                                let _ = app_handle_for_stream
                                    .emit(&format!("rpc:stream:{id}"), event_payload);
                            }
                        } else if let Some(id) = id_opt {
                            let mut p = sidecar2.pending.lock().await;
                            if let Some(tx) = p.remove(&id) {
                                let _ = tx.send(parsed);
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
    // Reap the child so it doesn't zombie if the app exits.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    // If a key is already configured, push it into the freshly spawned
    // sidecar so the SDK runner has it on the first sendPrompt. Errors
    // here are non-fatal — the renderer's first-launch flow will let the
    // user enter a key.
    match auth::get_api_key() {
        Ok(Some(key)) => {
            let _ = push_sidecar("auth.injectApiKey", serde_json::json!({ "key": key })).await;
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("[cedarpad] keychain read failed at boot: {e}");
        }
    }
    Ok(())
}

#[tauri::command]
async fn rpc(method: String, params: Value) -> Result<Value, String> {
    invoke_sidecar(&method, params).await
}

/// BYOK: persist the user's Anthropic API key in the OS keychain and push
/// it into the running sidecar so the SDK runner can use it. The renderer
/// passes the key in plaintext (it just typed it) — but never reads it
/// back via this or any other command.
#[tauri::command]
async fn auth_set_api_key(key: String) -> Result<(), String> {
    auth::set_api_key(&key)?;
    push_sidecar("auth.injectApiKey", serde_json::json!({ "key": key })).await?;
    Ok(())
}

#[tauri::command]
fn auth_has_api_key() -> Result<bool, String> {
    auth::has_api_key()
}

#[tauri::command]
async fn auth_delete_api_key() -> Result<(), String> {
    auth::delete_api_key()?;
    let _ = push_sidecar("auth.clearApiKey", serde_json::json!({})).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());

    // WebDriver plugin: debug-only. Lets `tauri-webdriver` drive the WebView
    // for e2e tests. See packages/app/e2e/webview/README in the repo for the
    // full setup; users running `tauri:dev` or `tauri build --debug` get the
    // server on port 4445 (native) / 4444 (intermediary).
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_sidecar(&handle).await {
                    eprintln!("[cedarpad] failed to start sidecar: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            auth_set_api_key,
            auth_has_api_key,
            auth_delete_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

