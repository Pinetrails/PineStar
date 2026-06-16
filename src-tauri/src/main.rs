// Skynet — native desktop shell (Tauri v2).
//
// Wraps the existing browser app: spawns the zero-dependency Node sidecar on a
// private loopback port, waits for it to listen, then opens that URL in a native
// WebView2 window. The sidecar's lifetime is bound to this process.
//
// Secrets (roadmap 2.1): the BYOK API key lives in the OS keychain (never in
// localStorage). The Rust side stores/reads it via the `keyring` crate and injects
// it into the sidecar's env at spawn (SKYNET_OPENROUTER_KEY) — read only there.
// Changing the key re-spawns the sidecar on the SAME fixed port so the running
// window keeps working without a URL change.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

const KEYCHAIN_SERVICE: &str = "ai.skynet.harness";
const KEYCHAIN_ACCOUNT: &str = "openrouter";

/// Shared runtime state: the fixed sidecar port, the project root, and the live child.
struct AppState {
    port: u16,
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

// ---- sidecar spawn / respawn ----

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

/// Kill any running sidecar and spawn a fresh one on the fixed port, injecting the
/// keychain key (if any) as SKYNET_OPENROUTER_KEY. Returns true once it's listening.
fn respawn_sidecar(state: &AppState) -> bool {
    state.kill_sidecar();
    let entry = state.root.join("sidecar").join("index.js");
    let mut cmd = Command::new("node");
    cmd.arg(&entry)
        .env("SKYNET_PORT", state.port.to_string())
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

// ---- Tauri commands (called from the frontend Harness seam) ----

/// Store (or, for an empty value, clear) the BYOK key in the OS keychain, then
/// restart the sidecar so it picks up the new key from its env.
#[tauri::command]
fn harness_store_key(key: String, state: State<AppState>) -> Result<(), String> {
    let entry = keychain_entry().map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(trimmed).map_err(|e| e.to_string())?;
    }
    respawn_sidecar(&state);
    Ok(())
}

/// Whether a BYOK key is configured — never returns the value itself.
#[tauri::command]
fn harness_has_key() -> bool {
    read_key().is_some()
}

/// Remove the BYOK key from the keychain and restart the sidecar without it.
#[tauri::command]
fn harness_clear_key(state: State<AppState>) -> Result<(), String> {
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    respawn_sidecar(&state);
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
            let state = AppState {
                port,
                root,
                sidecar: Mutex::new(None),
            };
            // Initial spawn — injects the key if one is already stored.
            let ready = respawn_sidecar(&state);
            app.manage(state);

            let url: WebviewUrl = if ready {
                WebviewUrl::External(
                    format!("http://127.0.0.1:{port}/")
                        .parse()
                        .expect("valid sidecar url"),
                )
            } else {
                eprintln!("[skynet] sidecar did not come up on port {port}");
                WebviewUrl::App("index.html".into())
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("SKYNET")
                .inner_size(1280.0, 832.0)
                .min_inner_size(960.0, 600.0)
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
