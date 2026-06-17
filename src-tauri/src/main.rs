// Skynet — native desktop shell (Tauri v2).
//
// Wraps the existing browser app: spawns the zero-dependency Node sidecar on a
// private loopback port, waits for it to listen, then opens that URL in a native
// WebView2 window. The sidecar's lifetime is bound to this process.
//
// Secrets (roadmap 2.1): the BYOK API key lives in the OS keychain (never in
// localStorage). The Rust side stores/reads it via the `keyring` crate. The key is
// injected into the sidecar's env at spawn AND can be updated live by POSTing it to
// the sidecar's token-guarded /api/key endpoint — so changing the key never restarts
// the sidecar (which would kill the page the user is on).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

const KEYCHAIN_SERVICE: &str = "ai.skynet.harness";
const KEYCHAIN_ACCOUNT: &str = "openrouter";

/// Shared runtime state: the fixed sidecar port, the per-launch IPC token (shared
/// only with the sidecar), the project root, and the live child.
struct AppState {
    port: u16,
    ipc_token: String,
    root: PathBuf,
    sidecar: Mutex<Option<Child>>,
}

impl AppState {
    fn kill_sidecar(&self) {
        if let Ok(mut guard) = self.sidecar.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.kill_sidecar();
    }
}

// ---- keychain (OS Credential Manager / Keychain / Secret Service via `keyring`) ----

fn keychain_entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// The stored BYOK key, or None if unset/empty.
fn read_key() -> Option<String> {
    keychain_entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|k| !k.trim().is_empty())
}

// ---- sidecar ----

/// Reserve an unused loopback port, then release it so the sidecar can bind it.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .expect("could not reserve a local port for the sidecar")
}

/// Node.js can't use a Windows `\\?\` verbatim path as its main module or cwd, so
/// normalize it back to a plain `C:\...` path.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// Directory holding `sidecar/index.js` (+ `frontend/`, `shared/`). Dev = live
/// worktree one level up; release = bundled resource dir.
fn project_root(app: &tauri::AppHandle) -> PathBuf {
    let raw = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    strip_verbatim(&raw)
}

/// Block (briefly) until the sidecar is accepting connections, or give up.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// Spawn the sidecar ONCE, injecting the keychain key (if any) as SKYNET_OPENROUTER_KEY
/// and the per-launch IPC token. Returns true once it's listening.
fn spawn_sidecar(state: &AppState) -> bool {
    let entry = state.root.join("sidecar").join("index.js");
    let mut cmd = Command::new("node");
    cmd.arg(&entry)
        .env("SKYNET_PORT", state.port.to_string())
        .env("SKYNET_IPC_TOKEN", &state.ipc_token)
        .current_dir(&state.root);
    if let Some(key) = read_key() {
        cmd.env("SKYNET_OPENROUTER_KEY", key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => {
            if let Ok(mut guard) = state.sidecar.lock() {
                *guard = Some(child);
            }
            wait_for_port(state.port, Duration::from_secs(25))
        }
        Err(e) => {
            eprintln!("[skynet] failed to spawn node sidecar: {e}");
            false
        }
    }
}

/// Push the live BYOK key to the already-running sidecar (no restart). The raw key is
/// the request body, authenticated by the per-launch IPC token. Blocks until the
/// sidecar acks, so the key is live before the caller proceeds to a run.
fn push_key(state: &AppState, key: &str) {
    use std::io::{Read, Write};
    let body = key.as_bytes();
    let head = format!(
        "POST /api/key HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Skynet-Token: {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.ipc_token,
        body.len()
    );
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", state.port)) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(body);
        let _ = s.flush();
        let mut buf = [0u8; 64];
        let _ = s.read(&mut buf); // wait for the 200 ack before returning
    }
}

// ---- Tauri commands (called from the frontend Harness seam) ----

/// Store (or, for an empty value, clear) the BYOK key in the OS keychain, then push it
/// to the running sidecar — no restart, so the current page is never disrupted.
#[tauri::command]
fn harness_store_key(key: String, state: State<AppState>) -> Result<(), String> {
    let entry = keychain_entry().map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(trimmed).map_err(|e| e.to_string())?;
    }
    push_key(&state, trimmed);
    Ok(())
}

/// Whether a BYOK key is configured — never returns the value itself.
#[tauri::command]
fn harness_has_key() -> bool {
    read_key().is_some()
}

/// Remove the BYOK key from the keychain and clear it on the running sidecar.
#[tauri::command]
fn harness_clear_key(state: State<AppState>) -> Result<(), String> {
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    push_key(&state, "");
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // A second launch should focus the running window, not spin up a 2nd sidecar.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            harness_store_key,
            harness_has_key,
            harness_clear_key
        ])
        .setup(|app| {
            let root = project_root(app.handle());
            let port = free_port();
            let ipc_token = uuid::Uuid::new_v4().to_string();
            let state = AppState {
                port,
                ipc_token,
                root,
                sidecar: Mutex::new(None),
            };
            let _ = spawn_sidecar(&state);
            app.manage(state);

            // The frontend is served LOCALLY (bundled via frontendDist), NOT from the sidecar's
            // http origin — Tauri denies IPC (the keychain commands) to remote origins. This shim
            // rewrites the frontend's root-relative /api/* fetches to the sidecar's port.
            let init = format!(
                "window.__SKYNET_API__='http://127.0.0.1:{port}';var _sf=window.fetch;window.fetch=function(u,o){{if(typeof u==='string'&&u.indexOf('/api/')===0)u=window.__SKYNET_API__+u;return _sf(u,o)}};"
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("SKYNET")
                .inner_size(1280.0, 832.0)
                .min_inner_size(960.0, 600.0)
                .initialization_script(&init)
                .center()
                .visible(false)
                // Reveal only after the document paints — avoids a white flash.
                .on_page_load(|window, _payload| {
                    let _ = window.show();
                })
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Skynet desktop shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.kill_sidecar();
                }
            }
        });
}
