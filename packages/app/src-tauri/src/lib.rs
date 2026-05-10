use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use once_cell::sync::OnceCell;
use serde_json::Value;
use tauri::Manager;
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
    let sidecar2 = sidecar.clone();
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
                        if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                            let mut p = sidecar2.pending.lock().await;
                            if let Some(tx) = p.remove(id) {
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
    Ok(())
}

#[tauri::command]
async fn rpc(method: String, params: Value) -> Result<Value, String> {
    invoke_sidecar(&method, params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_sidecar(&handle).await {
                    eprintln!("[cedarpad] failed to start sidecar: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
