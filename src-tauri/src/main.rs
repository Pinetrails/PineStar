// StarNet — native desktop shell (Tauri v2).
//
// Wraps the existing browser app: spawns the zero-dependency Node sidecar on a
// private loopback port, waits for it to listen, then opens that URL in a native
// WebView2 window. The sidecar's lifetime is bound to this process.
//
// Secrets (roadmap 2.1): BYOK API keys live in the OS keychain (never in
// localStorage). The Rust side stores/reads them via the `keyring` crate. Keys are
// injected into the sidecar's env at spawn AND can be updated live by POSTing provider
// config to the sidecar's token-guarded /api/key endpoint — so changing a key never
// restarts the sidecar (which would kill the page the user is on).
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
const KEYCHAIN_PROVIDERS: [&str; 13] = [
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "groq",
    "mistral",
    "deepseek",
    "together",
    "fireworks",
    "perplexity",
    "cerebras",
    "custom",
];
// Channel bot tokens live in the keychain under account "channel:<id>" and inject into the sidecar env at spawn
// as SKYNET_<ID>_TOKEN — the SAME posture as provider API keys above. (id, env_name) drives both spawn injection
// and the store/has commands. Adding a channel is one row here.
const SIDECAR_CHANNEL_TOKEN_ENVS: [(&str, &str); 2] = [
    ("telegram", "SKYNET_TELEGRAM_TOKEN"),
    ("discord", "SKYNET_DISCORD_TOKEN"),
];
const SIDECAR_PROVIDER_KEY_ENVS: [(&str, &str); 12] = [
    ("openai", "SKYNET_OPENAI_API_KEY"),
    ("anthropic", "SKYNET_ANTHROPIC_API_KEY"),
    ("gemini", "SKYNET_GEMINI_API_KEY"),
    ("xai", "SKYNET_XAI_API_KEY"),
    ("groq", "SKYNET_GROQ_API_KEY"),
    ("mistral", "SKYNET_MISTRAL_API_KEY"),
    ("deepseek", "SKYNET_DEEPSEEK_API_KEY"),
    ("together", "SKYNET_TOGETHER_API_KEY"),
    ("fireworks", "SKYNET_FIREWORKS_API_KEY"),
    ("perplexity", "SKYNET_PERPLEXITY_API_KEY"),
    ("cerebras", "SKYNET_CEREBRAS_API_KEY"),
    ("custom", "SKYNET_CUSTOM_OPENAI_KEY"),
];

/// Shared runtime state: the fixed sidecar port, the per-launch IPC token (shared
/// only with the sidecar), the project root, and the live child.
struct AppState {
    port: u16,
    ipc_token: String,
    api_token: String,
    root: PathBuf,
    workspaces: PathBuf,
    startup_log: Option<PathBuf>,
    sidecar: Mutex<Option<Child>>,
    keep_awake: Mutex<KeepAwakeState>,
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
struct KeepAwakeStatus {
    desktop: bool,
    supported: bool,
    enabled: bool,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyStatus {
    provider: String,
    configured: bool,
}

#[cfg(windows)]
struct KeepAwakeHandle {
    handle: windows_sys::Win32::Foundation::HANDLE,
    _reason: Vec<u16>,
}

#[cfg(windows)]
unsafe impl Send for KeepAwakeHandle {}

#[cfg(windows)]
impl KeepAwakeHandle {
    fn create() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, INVALID_HANDLE_VALUE,
        };
        use windows_sys::Win32::System::Power::{
            PowerCreateRequest, PowerSetRequest, PowerRequestSystemRequired,
        };
        use windows_sys::Win32::System::Threading::{
            REASON_CONTEXT, REASON_CONTEXT_0, POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        };

        let mut reason: Vec<u16> = "StarNet scheduled tasks are allowed to run while the app is open"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let context = REASON_CONTEXT {
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            return Err(format!("PowerCreateRequest failed with Windows error {code}"));
        }
        if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
            let code = unsafe { GetLastError() };
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("PowerSetRequest failed with Windows error {code}"));
        }
        Ok(Self {
            handle,
            _reason: reason,
        })
    }
}

#[cfg(windows)]
impl Drop for KeepAwakeHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Power::{
            PowerClearRequest, PowerRequestSystemRequired,
        };

        unsafe {
            let _ = PowerClearRequest(self.handle, PowerRequestSystemRequired);
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
struct KeepAwakeState {
    request: Option<KeepAwakeHandle>,
}

#[cfg(windows)]
impl KeepAwakeState {
    fn new() -> Self {
        Self { request: None }
    }

    fn status(&self) -> KeepAwakeStatus {
        KeepAwakeStatus {
            desktop: true,
            supported: true,
            enabled: self.request.is_some(),
            message: None,
        }
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<KeepAwakeStatus, String> {
        if enabled && self.request.is_none() {
            self.request = Some(KeepAwakeHandle::create()?);
        } else if !enabled {
            self.request = None;
        }
        Ok(self.status())
    }
}

#[cfg(not(windows))]
struct KeepAwakeState;

#[cfg(not(windows))]
impl KeepAwakeState {
    fn new() -> Self {
        Self
    }

    fn status(&self) -> KeepAwakeStatus {
        KeepAwakeStatus {
            desktop: true,
            supported: false,
            enabled: false,
            message: Some("Keep Computer Awake is currently supported on Windows desktop builds.".to_string()),
        }
    }

    fn set_enabled(&mut self, _enabled: bool) -> Result<KeepAwakeStatus, String> {
        Ok(self.status())
    }
}

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

fn workspace_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|dir| strip_verbatim(&dir).join("workspaces"))
        .unwrap_or_else(|_| {
            let base = std::env::var_os("LOCALAPPDATA")
                .or_else(|| std::env::var_os("APPDATA"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            base.join("ai.skynet.harness").join("workspaces")
        })
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn push_unique_path(out: &mut Vec<PathBuf>, path: PathBuf) {
    if out.iter().any(|p| same_path(p, &path)) {
        return;
    }
    out.push(path);
}

fn legacy_workspace_paths(root: &Path, current: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let appdata_bases = [
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("APPDATA").map(PathBuf::from),
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
    ];
    for base in appdata_bases.into_iter().flatten() {
        push_unique_path(&mut out, base.join("StarNet").join("workspaces"));
        push_unique_path(&mut out, base.join("Skynet").join("workspaces"));
        push_unique_path(&mut out, base.join("ai.skynet.harness").join("workspaces"));
    }
    push_unique_path(
        &mut out,
        strip_verbatim(root).join("sidecar").join("workspaces"),
    );
    push_unique_path(&mut out, strip_verbatim(root).join("workspaces"));
    out.into_iter()
        .filter(|path| !same_path(path, current))
        .collect()
}

fn copy_missing_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_file() {
        if !dst.exists() {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let _ = std::fs::copy(src, dst)?;
        }
        return Ok(());
    }
    if !meta.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        copy_missing_dir(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

fn migrate_workspace_data(current: &Path, legacy_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut migrated = Vec::new();
    let _ = std::fs::create_dir_all(current);
    for legacy in legacy_roots {
        if !legacy.is_dir() {
            continue;
        }
        if copy_missing_dir(legacy, current).is_ok() {
            migrated.push(legacy.clone());
        }
    }
    migrated
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

// ---- WebView2 stale-cache purge on version change ----------------------------------------
//
// The desktop webview loads the frontend COMPILED INTO the exe (tauri.localhost). WebView2
// caches those assets (Cache / `Code Cache/js`) and never revalidates. After an exe swap, V8
// can run OLD bytecode against NEW data — the 2026-07-06 incident (agents vanished from the
// world sim, COMMS fell back to the overseer). Fix: on every version change, delete the
// compiled/GPU caches while PRESERVING user state (Local Storage holds the world save under
// `starnet.save`). See docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md P0.1.

/// Pure decision: given the previously-recorded marker (if any) and the running version,
/// should we purge the stale webview caches? Purge on first run (no marker) or on any change.
/// Kept side-effect-free so it can be unit-tested without touching the filesystem.
fn should_purge_webview_cache(last_marker: Option<&str>, current_version: &str) -> bool {
    match last_marker {
        Some(prev) => prev.trim() != current_version.trim(),
        None => true,
    }
}

/// Marker file recording the version that last ran, next to the workspaces root
/// (`%APPDATA%\ai.skynet.harness\last-run-version`). Reused for the purge decision.
fn last_run_version_marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("last-run-version")
    })
}

/// Resolve the EBWebView user-data directory the webview will actually use. Honors the
/// WEBVIEW2_USER_DATA_FOLDER override; otherwise the Tauri/WebView2 default of
/// `%LOCALAPPDATA%\<identifier>\EBWebView`.
#[cfg(windows)]
fn webview2_user_data_dir(identifier: &str) -> Option<PathBuf> {
    if let Some(override_dir) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        let p = PathBuf::from(override_dir);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|base| base.join(identifier).join("EBWebView"))
}

/// Compiled/GPU cache subdirs under `EBWebView\Default` that are safe to delete on version
/// change. Deliberately EXCLUDES Local Storage / Session Storage / IndexedDB / Cookies —
/// those hold the user's world save and must be byte-preserved.
#[cfg(windows)]
const WEBVIEW2_STALE_CACHE_DIRS: [&str; 5] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
];

/// Delete the stale compiled/GPU caches under `<user_data>\Default`. Fails soft: a locked
/// or missing dir is logged and skipped, never fatal to boot. Returns the dirs actually
/// removed (for logging/telemetry).
#[cfg(windows)]
fn purge_webview2_caches(user_data_dir: &Path, startup_log: &Option<PathBuf>) -> Vec<String> {
    let default_dir = user_data_dir.join("Default");
    let mut removed = Vec::new();
    for name in WEBVIEW2_STALE_CACHE_DIRS {
        let target = default_dir.join(name);
        if !target.exists() {
            continue;
        }
        match std::fs::remove_dir_all(&target) {
            Ok(()) => {
                removed.push(name.to_string());
                log_startup(
                    startup_log,
                    format!("webview-cache-purge: removed {}", target.display()),
                );
            }
            Err(e) => {
                // App likely running / files locked — never crash boot, just record it.
                log_startup(
                    startup_log,
                    format!(
                        "webview-cache-purge: SKIP {} (soft-fail: {e})",
                        target.display()
                    ),
                );
            }
        }
    }
    removed
}

/// Top-level orchestration: compare the running version to the stored marker; on first run
/// or any change, purge the stale webview caches (Windows/WebView2 today; other platforms
/// hook in later), then record the new marker. Platform-neutral marker logic so a future
/// mac/linux (WebKit) purge can reuse the same decision path.
fn purge_stale_webview_cache_on_version_change(
    app: &tauri::AppHandle,
    identifier: &str,
    current_version: &str,
    startup_log: &Option<PathBuf>,
) {
    let marker_path = last_run_version_marker(app);
    let last = marker_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let last_trimmed = last.as_ref().map(|s| s.trim());

    if !should_purge_webview_cache(last_trimmed, current_version) {
        return;
    }

    log_startup(
        startup_log,
        format!(
            "webview-cache-purge: version change {:?} -> {} — purging stale caches (preserving Local Storage/IndexedDB/cookies)",
            last_trimmed, current_version
        ),
    );

    #[cfg(windows)]
    {
        match webview2_user_data_dir(identifier) {
            Some(user_data_dir) => {
                let removed = purge_webview2_caches(&user_data_dir, startup_log);
                log_startup(
                    startup_log,
                    format!(
                        "webview-cache-purge: done ({} of {} cache dir(s) removed) under {}",
                        removed.len(),
                        WEBVIEW2_STALE_CACHE_DIRS.len(),
                        user_data_dir.join("Default").display()
                    ),
                );
            }
            None => log_startup(
                startup_log,
                "webview-cache-purge: could not resolve EBWebView user-data dir — skipped",
            ),
        }
    }
    #[cfg(not(windows))]
    {
        // WebKit (macOS/Linux) caches live elsewhere; no purge wired yet. Marker still
        // advances so the decision path is exercised cross-platform.
        let _ = identifier;
        log_startup(
            startup_log,
            "webview-cache-purge: non-Windows platform — no cache purge wired yet",
        );
    }

    // Record the new marker LAST, so a crash mid-purge re-triggers a purge next boot rather
    // than leaving stale caches behind a satisfied marker.
    if let Some(path) = marker_path {
        if let Err(e) = std::fs::write(&path, current_version) {
            log_startup(
                startup_log,
                format!(
                    "webview-cache-purge: failed to write marker {} ({e})",
                    path.display()
                ),
            );
        }
    }
}

// ---- keychain (OS Credential Manager / Keychain / Secret Service via `keyring`) ----

fn normalize_provider(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" | "openai-codex" => "codex",
        "openai" | "openai-api" => "openai",
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" | "google-ai" | "google-gemini" => "gemini",
        "xai" | "x-ai" | "grok" => "xai",
        "groq" => "groq",
        "mistral" | "mistralai" => "mistral",
        "deepseek" => "deepseek",
        "together" | "together-ai" => "together",
        "fireworks" | "fireworks-ai" => "fireworks",
        "perplexity" | "pplx" | "sonar" => "perplexity",
        "cerebras" => "cerebras",
        "ollama" | "ollama-local" => "ollama",
        "custom" | "openai-compatible" | "local" | "vllm" | "lmstudio" => "custom",
        _ => "openrouter",
    }
}

fn keychain_account_for(provider: &str) -> String {
    match normalize_provider(provider) {
        // Preserve the original account name so existing OpenRouter keys keep working.
        "openrouter" => KEYCHAIN_ACCOUNT.to_string(),
        id => format!("provider:{id}"),
    }
}

fn keychain_entry() -> keyring::Result<keyring::Entry> {
    keychain_entry_for("openrouter")
}

fn keychain_entry_for(provider: &str) -> keyring::Result<keyring::Entry> {
    let account = keychain_account_for(provider);
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

/// The stored BYOK key, or None if unset/empty.
fn read_key() -> Option<String> {
    read_key_for("openrouter")
}

fn read_key_for(provider: &str) -> Option<String> {
    keychain_entry_for(provider)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|k| !k.trim().is_empty())
}

// ---- channel bot tokens (keychain account "channel:<id>") ----

/// Only the channels we actually inject (defends the keychain account namespace).
fn is_known_channel(channel: &str) -> bool {
    SIDECAR_CHANNEL_TOKEN_ENVS
        .iter()
        .any(|(id, _)| *id == channel)
}

fn channel_keychain_entry(channel: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, format!("channel:{channel}").as_str())
}

/// The stored bot token for a channel, or None if unset/empty.
fn read_channel_token(channel: &str) -> Option<String> {
    channel_keychain_entry(channel)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|t| !t.trim().is_empty())
}

/// Import any plaintext channel bot tokens from a legacy secrets.json into the keychain, then rewrite the file
/// WITHOUT the tokens (keeping every non-secret field). One-time migration for a desktop build that upgraded from
/// a plaintext-token world; a no-op when there are no plaintext tokens. Best-effort — a failure here never blocks
/// startup (the sidecar's own runtime layer keeps the session honest either way).
fn migrate_channel_tokens_from_plaintext(workspaces: &Path) {
    let file = workspaces.join("channels").join("secrets.json");
    let raw = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(_) => return, // no file -> nothing to migrate
    };
    let mut json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return, // corrupt -> leave it for the sidecar's resilient loader/.bak
    };
    let mut changed = false;
    for (channel, _) in SIDECAR_CHANNEL_TOKEN_ENVS {
        let token = json
            .get(channel)
            .and_then(|rec| rec.get("token"))
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        if let Some(token) = token {
            // Only store into the keychain if it doesn't already hold this channel's token (idempotent re-runs).
            if read_channel_token(channel).is_none() {
                if let Ok(entry) = channel_keychain_entry(channel) {
                    let _ = entry.set_password(&token);
                }
            }
            // Strip the plaintext token from the on-disk record regardless (the keychain is now the home).
            if let Some(rec) = json.get_mut(channel).and_then(|r| r.as_object_mut()) {
                rec.remove("token");
                changed = true;
            }
        }
    }
    if changed {
        if let Ok(serialized) = serde_json::to_string(&json) {
            let _ = std::fs::write(&file, serialized);
        }
    }
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
        .env("SKYNET_API_TOKEN", &state.api_token)
        .env("STARNET_WORKSPACES", state.workspaces.as_os_str())
        .env("SKYNET_WORKSPACES", state.workspaces.as_os_str())
        // Tells the sidecar it is running under the real desktop shell (a visible
        // WebView2 with a live screen), so the win32 computer-use driver defaults ON.
        // A headless/server/CI `node sidecar/index.js` never sets this, so it keeps the
        // safe no-driver stub. STARNET_COMPUTER_DRIVER still overrides either way.
        .env("STARNET_DESKTOP_SHELL", "1")
        .current_dir(&state.root);
    if let Some(key) = read_key() {
        cmd.env("SKYNET_OPENROUTER_KEY", key);
    }
    for (provider, env_name) in SIDECAR_PROVIDER_KEY_ENVS {
        if let Some(key) = read_key_for(provider) {
            cmd.env(env_name, key);
        }
    }
    // Channel bot tokens (Telegram/Discord) inject the same way — keychain -> env -> sidecar runtime layer.
    for (channel, env_name) in SIDECAR_CHANNEL_TOKEN_ENVS {
        if let Some(token) = read_channel_token(channel) {
            cmd.env(env_name, token);
        }
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
                eprintln!("[starnet] failed to spawn node sidecar: {e}");
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

// ---- watchdog: respawn a crashed sidecar so the open window keeps working ----
//
// If the sidecar node process exits unexpectedly (crash, OOM), the open page silently loses its
// backend and every /api/* fetch starts failing. One long-lived guardian thread polls the child
// every ~3s and, on an unexpected exit, respawns it on the same loopback port so the page can
// reconnect. `shutting_down` gates the respawn: it is flipped true at intentional quit BEFORE
// `kill_sidecar` runs, so killing the child during exit never races into a respawn.
//
// NOTE: system sleep is held off separately via the keep_awake command path (PowerCreateRequest);
// the watchdog does not touch power state.
fn spawn_guardian(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let st: &AppState = state.inner();
            if st.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            // Detect an unexpected exit while holding the lock, but release it BEFORE respawning —
            // spawn_sidecar takes the same lock itself, so respawning under it would deadlock.
            let mut needs_respawn = false;
            if let Ok(mut guard) = st.sidecar.lock() {
                if let Some(child) = guard.as_mut() {
                    if let Ok(Some(_status)) = child.try_wait() {
                        needs_respawn = true;
                    }
                }
            }
            if needs_respawn {
                // Re-check the flag: an intentional quit may have landed between the poll and now.
                if st.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                log_startup(&st.startup_log, "watchdog: sidecar exited unexpectedly — respawning");
                let _ = spawn_sidecar(st);
            }
        }
    });
}

/// Push the live provider config to the already-running sidecar (no restart). The JSON body is
/// authenticated by the per-launch IPC token. Blocks until the sidecar acks, so the config is live
/// before the caller proceeds to a run.
fn push_provider_config(
    state: &AppState,
    provider: &str,
    key: Option<&str>,
    base_url: Option<&str>,
) {
    use std::io::{Read, Write};
    let mut payload = serde_json::Map::new();
    payload.insert(
        "provider".to_string(),
        serde_json::Value::String(normalize_provider(provider).to_string()),
    );
    if let Some(key) = key {
        payload.insert(
            "key".to_string(),
            serde_json::Value::String(key.trim().to_string()),
        );
    }
    if let Some(base_url) = base_url {
        payload.insert(
            "baseUrl".to_string(),
            serde_json::Value::String(base_url.trim().to_string()),
        );
    }
    let body = serde_json::Value::Object(payload).to_string();
    let head = format!(
        "POST /api/key HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Skynet-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.ipc_token,
        body.as_bytes().len()
    );
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", state.port)) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(body.as_bytes());
        let _ = s.flush();
        let mut buf = [0u8; 64];
        let _ = s.read(&mut buf); // wait for the 200 ack before returning
    }
}

fn push_key(state: &AppState, key: &str) {
    push_provider_config(state, "openrouter", Some(key), None);
}

/// Push a channel bot token to the already-running sidecar (no restart), authenticated by the per-launch IPC
/// token — mirrors push_provider_config. An empty token clears it on the sidecar.
fn push_channel_token(state: &AppState, channel: &str, token: &str) {
    use std::io::{Read, Write};
    let mut payload = serde_json::Map::new();
    payload.insert(
        "channel".to_string(),
        serde_json::Value::String(channel.to_string()),
    );
    payload.insert(
        "token".to_string(),
        serde_json::Value::String(token.trim().to_string()),
    );
    let body = serde_json::Value::Object(payload).to_string();
    let head = format!(
        "POST /api/channels/token HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Skynet-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.ipc_token,
        body.as_bytes().len()
    );
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", state.port)) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(body.as_bytes());
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

/// Store/clear the key for one provider and optionally update its runtime base URL.
/// The key never returns to the WebView; only configured booleans do.
#[tauri::command]
fn harness_store_provider_key(
    provider: String,
    key: Option<String>,
    base_url: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let provider_id = normalize_provider(&provider);
    let key_trimmed = key.as_ref().map(|k| k.trim().to_string());
    if let Some(ref key_value) = key_trimmed {
        if provider_id != "codex" && provider_id != "ollama" {
            let entry = keychain_entry_for(provider_id).map_err(|e| e.to_string())?;
            if key_value.is_empty() {
                let _ = entry.delete_credential();
            } else {
                entry.set_password(key_value).map_err(|e| e.to_string())?;
            }
        }
    }
    let base_trimmed = base_url.as_ref().map(|u| u.trim().to_string());
    push_provider_config(
        &state,
        provider_id,
        key_trimmed.as_deref(),
        base_trimmed.as_deref(),
    );
    Ok(())
}

/// Whether a BYOK key is configured — never returns the value itself.
#[tauri::command]
fn harness_has_key() -> bool {
    read_key().is_some()
}

#[tauri::command]
fn harness_has_provider_key(provider: String) -> bool {
    read_key_for(normalize_provider(&provider)).is_some()
}

#[tauri::command]
fn harness_provider_key_status() -> Vec<ProviderKeyStatus> {
    KEYCHAIN_PROVIDERS
        .iter()
        .map(|provider| ProviderKeyStatus {
            provider: provider.to_string(),
            configured: read_key_for(provider).is_some(),
        })
        .collect()
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

/// Store (or, for an empty value, clear) a channel bot token in the OS keychain, then push it to the running
/// sidecar — no restart, so the current page is never disrupted. The token never returns to the WebView.
#[tauri::command]
fn harness_store_channel_token(
    channel: String,
    token: String,
    state: State<AppState>,
) -> Result<(), String> {
    let channel = channel.trim().to_ascii_lowercase();
    if !is_known_channel(&channel) {
        return Err(format!("unknown channel: {channel}"));
    }
    let entry = channel_keychain_entry(&channel).map_err(|e| e.to_string())?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(trimmed).map_err(|e| e.to_string())?;
    }
    push_channel_token(&state, &channel, trimmed);
    Ok(())
}

/// Whether a channel bot token is configured in the keychain — never returns the value itself.
#[tauri::command]
fn harness_has_channel_token(channel: String) -> bool {
    let channel = channel.trim().to_ascii_lowercase();
    is_known_channel(&channel) && read_channel_token(&channel).is_some()
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

/// Toggle the main StarNet desktop window between windowed and fullscreen mode.
#[tauri::command]
fn starnet_toggle_fullscreen(app: AppHandle) -> Result<bool, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    let next = !win.is_fullscreen().map_err(|e| e.to_string())?;
    win.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Prevent idle system sleep while StarNet is open. This does not force the
/// display to stay on; it only keeps scheduled tasks from being paused by OS sleep.
#[tauri::command]
fn starnet_set_keep_awake(
    enabled: bool,
    state: State<AppState>,
) -> Result<KeepAwakeStatus, String> {
    state
        .keep_awake
        .lock()
        .map_err(|_| "keep-awake state is unavailable".to_string())?
        .set_enabled(enabled)
}

/// Read the current native keep-awake state without changing the OS assertion.
#[tauri::command]
fn starnet_keep_awake_status(state: State<AppState>) -> Result<KeepAwakeStatus, String> {
    Ok(state
        .keep_awake
        .lock()
        .map_err(|_| "keep-awake state is unavailable".to_string())?
        .status())
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

/// P1.5 build provenance: the app version + the git commit/dirty state this binary was compiled from (stamped by
/// build.rs). The frontend diagnostics panel renders "build <version> @ <commit>[ DIRTY]" so a user (or the release
/// train) can prove exactly which source produced an installed exe. Commit is "unknown" when git was unavailable
/// at build time (never a hard failure).
#[derive(serde::Serialize)]
struct BuildInfo {
    version: String,
    commit: String,
    describe: String,
    dirty: bool,
}

#[tauri::command]
fn starnet_build_info(app: AppHandle) -> BuildInfo {
    BuildInfo {
        version: app.package_info().version.to_string(),
        commit: env!("STARNET_BUILD_COMMIT").to_string(),
        describe: env!("STARNET_BUILD_DESCRIBE").to_string(),
        dirty: env!("STARNET_BUILD_DIRTY") == "1",
    }
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
            harness_store_provider_key,
            harness_has_key,
            harness_has_provider_key,
            harness_provider_key_status,
            harness_clear_key,
            harness_store_channel_token,
            harness_has_channel_token,
            open_external_url,
            starnet_toggle_fullscreen,
            starnet_set_keep_awake,
            starnet_keep_awake_status,
            starnet_update_status,
            starnet_update_check,
            starnet_update_install,
            starnet_build_info
        ])
        .setup(|app| {
            let root = project_root(app.handle());
            let port = free_port();
            let ipc_token = uuid::Uuid::new_v4().to_string();
            // per-launch API token: shared with the sidecar via env (it reads SKYNET_API_TOKEN) AND injected
            // into the bundled webview below, so the desktop UI never has to fetch the token over an open route.
            let api_token = uuid::Uuid::new_v4().to_string();
            let startup_log = startup_log_path(app.handle());
            let workspaces = workspace_path(app.handle());
            let migrated_workspaces = migrate_workspace_data(
                &workspaces,
                &legacy_workspace_paths(&root, &workspaces),
            );
            log_startup(
                &startup_log,
                format!(
                    "startup exe={:?} resource_dir={:?} root={} workspaces={} migrated_from={:?} port={}",
                    std::env::current_exe(),
                    app.path().resource_dir(),
                    root.display(),
                    workspaces.display(),
                    migrated_workspaces,
                    port
                ),
            );
            // One-time: lift any plaintext channel bot tokens into the keychain and strip them from the file,
            // BEFORE spawning the sidecar so the injected SKYNET_<ID>_TOKEN env reflects the migrated tokens.
            migrate_channel_tokens_from_plaintext(&workspaces);
            let state = AppState {
                port,
                ipc_token,
                api_token: api_token.clone(),
                root,
                workspaces,
                startup_log,
                sidecar: Mutex::new(None),
                keep_awake: Mutex::new(KeepAwakeState::new()),
                shutting_down: AtomicBool::new(false),
            };
            let _ = spawn_sidecar(&state);
            app.manage(state);
            app.manage(PendingUpdate(Mutex::new(None)));

            // Respawn the sidecar if it crashes while the window is open (see spawn_guardian).
            spawn_guardian(app.handle().clone());

            // The frontend is served LOCALLY (bundled via frontendDist), NOT from the sidecar's
            // http origin — Tauri denies IPC (the keychain commands) to remote origins. This shim
            // rewrites the frontend's root-relative /api/* fetches to the sidecar's port.
            let init = format!(
                "window.__STARNET_API__='http://127.0.0.1:{port}';window.__STARNET_API_TOKEN__='{api_token}';var _sf=window.fetch;window.fetch=function(u,o){{if(typeof u==='string'&&u.indexOf('/api/')===0)u=window.__STARNET_API__+u;return _sf(u,o)}};"
            );

            // Purge stale WebView2 compiled/GPU caches when the app version changed, BEFORE the
            // webview window is created — otherwise V8 can run old bytecode against new data
            // (see docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md P0.1). Fails soft; never blocks boot.
            {
                let handle = app.handle();
                let identifier = handle.config().identifier.clone();
                let current_version = handle.package_info().version.to_string();
                let log = startup_log_path(handle);
                purge_stale_webview_cache_on_version_change(
                    handle,
                    &identifier,
                    &current_version,
                    &log,
                );
            }

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
        .expect("failed to build the StarNet desktop shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    // Stop the guardian from respawning before we kill the child.
                    state.shutting_down.store(true, Ordering::SeqCst);
                    state.kill_sidecar();
                }
            }
        });
}

#[cfg(test)]
mod webview_cache_purge_tests {
    use super::*;

    #[test]
    fn purges_on_first_run_when_marker_missing() {
        assert!(should_purge_webview_cache(None, "0.2.4"));
    }

    #[test]
    fn purges_when_version_changed() {
        assert!(should_purge_webview_cache(Some("0.2.3"), "0.2.4"));
    }

    #[test]
    fn no_purge_when_version_unchanged() {
        assert!(!should_purge_webview_cache(Some("0.2.4"), "0.2.4"));
    }

    #[test]
    fn tolerates_whitespace_in_marker() {
        // Markers are written via fs::write and read back with read_to_string; a trailing
        // newline or stray whitespace must NOT be read as a version change (would purge every
        // boot). trim() on both sides guards that.
        assert!(!should_purge_webview_cache(Some("0.2.4\n"), "0.2.4"));
        assert!(!should_purge_webview_cache(Some("  0.2.4  "), "0.2.4"));
    }

    #[cfg(windows)]
    #[test]
    fn honors_env_override_for_user_data_dir() {
        // Serialize env mutation within this test; other tests don't touch these vars.
        let key = "WEBVIEW2_USER_DATA_FOLDER";
        let prev = std::env::var_os(key);
        std::env::set_var(key, r"C:\some\custom\webview");
        let got = webview2_user_data_dir("ai.skynet.harness");
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        assert_eq!(got, Some(PathBuf::from(r"C:\some\custom\webview")));
    }

    #[cfg(windows)]
    #[test]
    fn purge_deletes_caches_but_preserves_user_state() {
        use std::io::Write;

        // Build a fake EBWebView\Default tree in a unique temp dir.
        let base = std::env::temp_dir().join(format!(
            "starnet-wvpurge-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let default_dir = base.join("Default");
        std::fs::create_dir_all(&default_dir).unwrap();

        // Caches that MUST be deleted.
        for name in WEBVIEW2_STALE_CACHE_DIRS {
            let d = default_dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let mut f = std::fs::File::create(d.join("stale.bin")).unwrap();
            f.write_all(b"old-bytecode").unwrap();
        }

        // User state that MUST be preserved (world save lives in Local Storage).
        for name in ["Local Storage", "Session Storage", "IndexedDB"] {
            let d = default_dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let mut f = std::fs::File::create(d.join("keep.bin")).unwrap();
            f.write_all(b"starnet.save").unwrap();
        }
        let cookies = default_dir.join("Cookies");
        std::fs::write(&cookies, b"cookie-jar").unwrap();

        let removed = purge_webview2_caches(&base, &None);

        // Every cache dir gone.
        for name in WEBVIEW2_STALE_CACHE_DIRS {
            assert!(
                !default_dir.join(name).exists(),
                "cache dir {name} should have been removed"
            );
        }
        assert_eq!(removed.len(), WEBVIEW2_STALE_CACHE_DIRS.len());

        // Every user-state dir/file preserved.
        for name in ["Local Storage", "Session Storage", "IndexedDB"] {
            assert!(
                default_dir.join(name).join("keep.bin").exists(),
                "user state {name} must be preserved"
            );
        }
        assert!(cookies.exists(), "Cookies must be preserved");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn purge_is_soft_when_default_dir_absent() {
        // Missing user-data dir must not panic and must remove nothing.
        let base = std::env::temp_dir().join(format!(
            "starnet-wvpurge-absent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let removed = purge_webview2_caches(&base, &None);
        assert!(removed.is_empty());
    }
}
