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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};

const KEYCHAIN_SERVICE: &str = "ai.skynet.harness";
const KEYCHAIN_ACCOUNT: &str = "openrouter";

/// Shared runtime state: the fixed sidecar port, the per-launch IPC token (shared
/// only with the sidecar), the project root, and the live child.
struct AppState {
    port: u16,
    ipc_token: String,
    root: PathBuf,
    startup_log: Option<PathBuf>,
    sidecar: Mutex<Option<Child>>,
    // Flipped true the instant the app starts exiting, so the guardian thread stops
    // respawning the sidecar during an intentional quit.
    shutting_down: AtomicBool,
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

struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    desktop: bool,
    current_version: String,
    target: Option<String>,
    pending: Option<UpdateMetadata>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    available: bool,
    checked_at: u64,
    update: Option<UpdateMetadata>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata {
    version: String,
    current_version: String,
    date: Option<String>,
    body: Option<String>,
    target: String,
    critical: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
enum UpdateInstallEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
    Installing,
}

fn update_metadata(update: &Update) -> UpdateMetadata {
    UpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|d| d.to_string()),
        body: update.body.clone(),
        target: update.target.clone(),
        critical: update
            .raw_json
            .get("critical")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.kill_sidecar();
    }
}

fn startup_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("startup.log")
    })
}

fn log_startup(path: &Option<PathBuf>, message: impl AsRef<str>) {
    let Some(path) = path else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        use std::io::Write;
        let _ = writeln!(file, "{}", message.as_ref());
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
    let candidates = if cfg!(debug_assertions) {
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))]
    } else {
        let mut paths = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                paths.push(dir.to_path_buf());
            }
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            paths.push(resource_dir);
        }
        paths.push(PathBuf::from("."));
        paths
    };
    candidates
        .into_iter()
        .map(|p| strip_verbatim(&p))
        .find(|p| p.join("sidecar").join("index.js").exists())
        .unwrap_or_else(|| PathBuf::from("."))
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

/// Resolve the Node runtime. Packaged builds ship one via Tauri externalBin;
/// dev builds fall back to the system PATH.
fn node_binary(root: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let root_candidate = root.join(name);
    if root_candidate.exists() {
        return root_candidate;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("node")
}

fn sidecar_command(state: &AppState, entry: &Path, node: &Path) -> Command {
    let mut cmd = Command::new(node);
    cmd.arg(entry)
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
    cmd
}

/// Spawn the sidecar ONCE, injecting the keychain key (if any) as SKYNET_OPENROUTER_KEY
/// and the per-launch IPC token. Returns true once it's listening.
fn spawn_sidecar(state: &AppState) -> bool {
    let entry = state.root.join("sidecar").join("index.js");
    let node = node_binary(&state.root);
    log_startup(
        &state.startup_log,
        format!(
            "spawn_sidecar root={} entry={} entry_exists={} node={} node_exists={}",
            state.root.display(),
            entry.display(),
            entry.exists(),
            node.display(),
            node.exists()
        ),
    );

    let mut last_error = None;
    for attempt in 0..=20 {
        match sidecar_command(state, &entry, &node).spawn() {
            Ok(child) => {
                let pid = child.id();
                if let Ok(mut guard) = state.sidecar.lock() {
                    *guard = Some(child);
                }
                let listening = wait_for_port(state.port, Duration::from_secs(25));
                log_startup(
                    &state.startup_log,
                    format!(
                        "spawn_sidecar pid={pid} port={} listening={listening}",
                        state.port
                    ),
                );
                return listening;
            }
            Err(e) if cfg!(windows) && e.raw_os_error() == Some(32) && attempt < 20 => {
                last_error = Some(e.to_string());
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                log_startup(&state.startup_log, format!("spawn_sidecar failed: {e}"));
                eprintln!("[skynet] failed to spawn node sidecar: {e}");
                return false;
            }
        }
    }
    log_startup(
        &state.startup_log,
        format!(
            "spawn_sidecar failed after retrying locked node.exe: {}",
            last_error.unwrap_or_else(|| "unknown error".to_string())
        ),
    );
    false
}

// ---- stay-alive: keep cron firing while the window is open ----
//
// Two small guards so "leave StarNet open and it runs 24/7" is actually true:
//   * WAKE-LOCK — while the scheduler is armed AND has at least one routine, hold off
//     SYSTEM sleep (ES_SYSTEM_REQUIRED) so an idle overnight PC keeps ticking. We do NOT
//     pass ES_DISPLAY_REQUIRED, so the screen is still free to sleep — only the machine
//     stays awake. Released the moment cron is disarmed or has no jobs.
//   * WATCHDOG — if the sidecar process exits unexpectedly (crash, OOM), respawn it on
//     the same loopback port so the open page can reconnect, instead of silently dying.
//
// Both live in ONE long-lived guardian thread: the wake-lock must be (re)set from a stable
// thread — the ES_CONTINUOUS requirement is cleared if its setting thread exits — and sharing
// the thread keeps the watchdog and the cron poll on one cheap timer.

/// Hold off (true) or release (false) system sleep. No-op away from Windows. MUST be called
/// from the long-lived guardian thread (ES_CONTINUOUS persists only while its thread lives).
#[cfg(windows)]
fn set_wakelock(on: bool) {
    // kernel32 — declared inline so we pull in no extra crate.
    extern "system" {
        fn SetThreadExecutionState(es_flags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    let flags = if on {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    unsafe {
        SetThreadExecutionState(flags);
    }
}

#[cfg(not(windows))]
fn set_wakelock(_on: bool) {}

/// One raw-HTTP GET against the loopback sidecar; returns the response body (headers stripped).
fn http_get_local(port: u16, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(4)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    s.flush().ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let idx = text.find("\r\n\r\n")?;
    Some(text[idx + 4..].to_string())
}

/// Ask the sidecar whether sleep should be held off: Some(true) iff the scheduler is armed
/// AND at least one routine exists, Some(false) otherwise, None if the sidecar can't be
/// reached (the caller keeps the previous state rather than flapping the lock).
fn cron_wants_wakelock(port: u16) -> Option<bool> {
    let body = http_get_local(port, "/api/cron")?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let armed = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
    let has_jobs = v
        .get("jobs")
        .and_then(|x| x.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    Some(armed && has_jobs)
}

/// The guardian loop: watchdog every ~3s, wake-lock reconcile every ~21s. Runs until the app
/// signals shutdown, then releases the wake-lock and exits.
fn spawn_guardian(app: AppHandle) {
    std::thread::spawn(move || {
        let mut lock_held = false;
        let mut ticks: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let st: &AppState = state.inner();
            if st.shutting_down.load(Ordering::SeqCst) {
                set_wakelock(false);
                break;
            }

            // WATCHDOG: respawn the sidecar if it exited unexpectedly. Don't hold the lock
            // across the respawn — spawn_sidecar takes it itself.
            let mut needs_respawn = false;
            if let Ok(mut guard) = st.sidecar.lock() {
                if let Some(Ok(Some(_status))) = guard.as_mut().map(|c| c.try_wait()) {
                    needs_respawn = true;
                }
            }
            if needs_respawn {
                log_startup(&st.startup_log, "watchdog: sidecar exited — respawning");
                let _ = spawn_sidecar(st);
            }

            // WAKE-LOCK: reconcile against the live cron state every ~21s (≪ any sleep timer).
            ticks += 1;
            if ticks % 7 == 1 {
                if let Some(want) = cron_wants_wakelock(st.port) {
                    if want != lock_held {
                        set_wakelock(want);
                        lock_held = want;
                        log_startup(
                            &st.startup_log,
                            format!("wakelock {}", if want { "engaged" } else { "released" }),
                        );
                    }
                }
            }
        }
    });
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

/// Open an OAuth/device-auth URL in the user's default system browser.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened externally".to_string());
    }

    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    Ok(())
}

/// Desktop updater status without hitting the network. The frontend uses this to
/// render the Update Center immediately and decide whether native updates exist.
#[tauri::command]
fn starnet_update_status(
    app: AppHandle,
    pending_update: State<PendingUpdate>,
) -> Result<UpdateStatus, String> {
    let pending = pending_update
        .0
        .lock()
        .map_err(|_| "update state is unavailable".to_string())?
        .as_ref()
        .map(update_metadata);
    Ok(UpdateStatus {
        desktop: true,
        current_version: app.package_info().version.to_string(),
        target: tauri_plugin_updater::target(),
        pending,
    })
}

/// Check the signed release manifest and cache the verified update object if a
/// newer build exists. No install happens until the user asks for it.
#[tauri::command]
async fn starnet_update_check(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<UpdateCheck, String> {
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let metadata = update.as_ref().map(update_metadata);
    *pending_update
        .0
        .lock()
        .map_err(|_| "update state is unavailable".to_string())? = update;
    Ok(UpdateCheck {
        available: metadata.is_some(),
        checked_at: now_ms(),
        update: metadata,
    })
}

/// Download, verify, and install the pending update. On Windows the updater exits
/// the app as the installer starts; on other desktop platforms we restart after a
/// successful install so the user lands on the new version.
#[tauri::command]
async fn starnet_update_install(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
    on_event: Channel<UpdateInstallEvent>,
) -> Result<(), String> {
    let update = {
        let mut guard = pending_update
            .0
            .lock()
            .map_err(|_| "update state is unavailable".to_string())?;
        guard
            .take()
            .ok_or_else(|| "there is no pending update".to_string())?
    };

    let mut started = false;
    let install_result = update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(UpdateInstallEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(UpdateInstallEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(UpdateInstallEvent::Finished);
            },
        )
        .await;

    if let Err(e) = install_result {
        if let Ok(mut guard) = pending_update.0.lock() {
            *guard = Some(update);
        }
        return Err(e.to_string());
    }

    let _ = on_event.send(UpdateInstallEvent::Installing);
    app.restart()
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            harness_store_key,
            harness_has_key,
            harness_clear_key,
            open_external_url,
            starnet_update_status,
            starnet_update_check,
            starnet_update_install
        ])
        .setup(|app| {
            let root = project_root(app.handle());
            let port = free_port();
            let ipc_token = uuid::Uuid::new_v4().to_string();
            let startup_log = startup_log_path(app.handle());
            log_startup(
                &startup_log,
                format!(
                    "startup exe={:?} resource_dir={:?} root={} port={}",
                    std::env::current_exe(),
                    app.path().resource_dir(),
                    root.display(),
                    port
                ),
            );
            let state = AppState {
                port,
                ipc_token,
                root,
                startup_log,
                sidecar: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
            };
            let _ = spawn_sidecar(&state);
            app.manage(state);
            app.manage(PendingUpdate(Mutex::new(None)));

            // Keep the agent alive while the window is open: respawn a crashed sidecar and
            // hold off system sleep whenever the scheduler is armed (see spawn_guardian).
            spawn_guardian(app.handle().clone());

            // The frontend is served LOCALLY (bundled via frontendDist), NOT from the sidecar's
            // http origin — Tauri denies IPC (the keychain commands) to remote origins. This shim
            // rewrites the frontend's root-relative /api/* fetches to the sidecar's port.
            let init = format!(
                "window.__STARNET_API__='http://127.0.0.1:{port}';var _sf=window.fetch;window.fetch=function(u,o){{if(typeof u==='string'&&u.indexOf('/api/')===0)u=window.__STARNET_API__+u;return _sf(u,o)}};"
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("StarNet")
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
                    state.shutting_down.store(true, Ordering::SeqCst);
                    state.kill_sidecar();
                }
            }
        });
}
