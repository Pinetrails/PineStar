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

use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    ipc::Channel, AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
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
    /// Kill the child sidecar on intentional shutdown. HONESTY NOTE: this only covers the
    /// graceful paths — the ExitRequested run-event and `Drop for AppState`. A hard kill of
    /// the shell (`taskkill /F`, crash, task-manager End Task, power loss) runs NEITHER, and
    /// there is no in-process hook that can — which is exactly how orphan sidecars happen.
    /// The reliable other half is `reap_orphan_sidecars`, which runs at the NEXT boot before
    /// spawning and terminates any process still running from our own bundled node runtime.
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

/// Lane 4D: the parsed result of a GET /api/lifecycle/armed poll — the sidecar's truthful account of whether
/// any background work (armed routines, connected channels, an armed night-shift) requires the process to keep
/// running after the window closes. `reasons` are short human strings the tray shows verbatim.
struct LifecycleArmed {
    armed: bool,
    reasons: Vec<String>,
}

/// Handles to the mutable tray menu items so the background poll thread can keep the tray honest (the status
/// line + tooltip must reflect REAL armed state, never a stale or optimistic claim).
struct TrayHandles {
    status: tauri::menu::MenuItem<tauri::Wry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutostartStatus {
    desktop: bool,
    enabled: bool,
}

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

/// Name of the one-shot done-marker dropped in the live workspace root after the FIRST
/// successful legacy migration. Its presence is the sole signal to never migrate again.
const MIGRATION_MARKER: &str = ".migrated";
const MIGRATION_PENDING_MARKER: &str = ".migration-pending";

/// True when the live workspace root already holds real data (anything other than our own
/// marker file). A pre-existing populated root means an earlier install/migration already ran,
/// so we must NOT copy from legacy roots — doing so resurrects files the user deleted.
fn workspace_has_content(current: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(current) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.file_name() != std::ffi::OsStr::new(MIGRATION_MARKER))
}

/// One-time import of data from legacy workspace roots into the live one. THIS RUNS ONCE, EVER.
///
/// Bug it fixes (audit 0.1): running unconditionally every boot means `copy_missing_dir` re-copies
/// any file present in a stale legacy root (e.g. %LOCALAPPDATA%\StarNet\workspaces) but absent in
/// the live root — so agents/prospects/sessions the user DELETED silently reappear on the next
/// launch. Guard rails, checked before any copy:
///   1. If the `.migrated` marker exists in the live root, skip entirely (the definitive signal).
///   2. Belt-and-suspenders: if the live root already has real content, skip and drop the marker
///      so a first-run-with-marker-missing but already-populated install never migrates either.
/// A pending marker is written BEFORE copying. A crash or returned I/O error therefore retries
/// the idempotent, copy-missing-only pass instead of mistaking its partial tree for live data.
fn migrate_workspace_data(
    current: &Path,
    legacy_roots: &[PathBuf],
    startup_log: &Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut migrated = Vec::new();
    let _ = std::fs::create_dir_all(current);
    let marker = current.join(MIGRATION_MARKER);
    let pending = current.join(MIGRATION_PENDING_MARKER);

    // (1) Already migrated once — never touch legacy roots again.
    if marker.exists() {
        let _ = std::fs::remove_file(&pending);
        return migrated;
    }
    // (2) Live root already populated (upgrade from a pre-marker build, or a manual copy): treat
    //     as already-migrated. Stamp the marker so future boots take the fast path at (1).
    if !pending.exists() && workspace_has_content(current) {
        let _ = std::fs::write(&marker, b"1");
        return migrated;
    }

    // Stamp BEFORE copying so both a process crash and a returned I/O error remain retryable
    // even when the partial pass created directories or copied some files.
    if let Err(error) = std::fs::write(&pending, b"1") {
        log_startup(
            startup_log,
            format!(
                "workspace-migration: RETRY required; could not create pending marker {}: {error}",
                pending.display()
            ),
        );
        return migrated;
    }

    let mut copy_failed = false;
    for legacy in legacy_roots {
        if !legacy.is_dir() {
            continue;
        }
        match copy_missing_dir(legacy, current) {
            Ok(()) => migrated.push(legacy.clone()),
            Err(error) => {
                copy_failed = true;
                log_startup(
                    startup_log,
                    format!(
                        "workspace-migration: RETRY required; copy from {} failed: {error}",
                        legacy.display()
                    ),
                );
            }
        }
    }
    if copy_failed {
        return migrated;
    }
    // Marker written LAST, after all copies land: crash-safe (a mid-copy crash leaves no marker,
    // so the idempotent copy-missing pass simply re-runs next boot).
    match std::fs::write(&marker, b"1") {
        Ok(()) => {
            let _ = std::fs::remove_file(&pending);
        }
        Err(error) => log_startup(
            startup_log,
            format!(
                "workspace-migration: RETRY required; could not write completion marker {}: {error}",
                marker.display()
            ),
        ),
    }
    migrated
}

#[cfg(test)]
mod workspace_migration_tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-workspace-migration-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[cfg(windows)]
    #[test]
    fn failed_copy_leaves_migration_retryable() {
        use std::os::windows::fs::OpenOptionsExt;

        let base = temp_dir("locked-source");
        let legacy = base.join("legacy");
        let current = base.join("current");
        let startup_log = base.join("startup.log");
        std::fs::create_dir_all(legacy.join("sessions")).unwrap();
        let source = legacy.join("sessions").join("history.jsonl");
        std::fs::write(&source, b"important session").unwrap();

        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        let migrated = migrate_workspace_data(
            &current,
            std::slice::from_ref(&legacy),
            &Some(startup_log.clone()),
        );
        assert!(migrated.is_empty(), "a failed legacy root is not reported as migrated");
        assert!(
            !current.join(MIGRATION_MARKER).exists(),
            "a failed copy must not stamp the one-shot marker"
        );
        assert!(current.join(MIGRATION_PENDING_MARKER).exists());
        let failure_log = std::fs::read_to_string(&startup_log).unwrap();
        assert!(failure_log.contains("RETRY required"));
        assert!(failure_log.contains(&legacy.display().to_string()));

        drop(lock);
        let retried = migrate_workspace_data(&current, std::slice::from_ref(&legacy), &None);
        assert_eq!(retried, vec![legacy.clone()], "the next boot retries the legacy root");
        assert_eq!(
            std::fs::read(current.join("sessions").join("history.jsonl")).unwrap(),
            b"important session"
        );
        assert!(current.join(MIGRATION_MARKER).exists());
        assert!(!current.join(MIGRATION_PENDING_MARKER).exists());

        let _ = std::fs::remove_dir_all(base);
    }
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

// ---- WebView2 stale-cache purge on packaged-build change ---------------------------------
//
// The desktop webview loads the frontend COMPILED INTO the exe (tauri.localhost). WebView2
// caches those assets (Cache / `Code Cache/js`) and never revalidates. After an exe swap, V8
// can run OLD bytecode against NEW data — the 2026-07-06 incident (agents vanished from the
// world sim, COMMS fell back to the overseer). A version-only marker is insufficient: release
// candidates are routinely rebuilt and reinstalled under the same semver, which left the old
// voice controller running after the fixed 0.8.0 installer was installed. Key the marker to the
// exact executable bytes and purge on every packaged-build change while PRESERVING user state
// (Local Storage holds the world save under `starnet.save`).

/// Pure decision: given the previously-recorded marker (if any) and the running build identity,
/// should we purge the stale webview caches? Purge on first run (no marker) or on any change.
/// Kept side-effect-free so it can be unit-tested without touching the filesystem.
fn should_purge_webview_cache(last_marker: Option<&str>, current_build: &str) -> bool {
    match last_marker {
        Some(prev) => prev.trim() != current_build.trim(),
        None => true,
    }
}

/// Stable marker payload for the exact packaged executable. The runtime SHA is the authority:
/// unlike semver or the Git tree it changes for a same-version rebuild and covers generated bundle
/// inputs. If hashing the executable fails, fall back to the strongest compile-time source identity.
fn webview_build_identity(current_version: &str) -> String {
    let (executable_sha, executable_size) = runtime_executable_identity();
    let artifact = if !executable_sha.is_empty() && executable_size > 0 {
        format!("exe:{executable_sha}:{executable_size}")
    } else {
        format!(
            "source:{}:{}:{}",
            env!("STARNET_BUILD_SHA"),
            env!("STARNET_BUILD_TREE"),
            env!("STARNET_BUILD_DESCRIBE")
        )
    };
    format!("{}|{}", current_version.trim(), artifact)
}

/// Marker file recording the exact build that last ran. The legacy filename is retained so
/// existing version-only markers differ and force the required one-time migration purge.
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

/// Top-level orchestration: compare the exact running build to the stored marker; on first run
/// or any build change, purge the stale webview caches (Windows/WebView2 today; other platforms
/// hook in later), then record the new marker. Platform-neutral marker logic so a future
/// mac/linux (WebKit) purge can reuse the same decision path.
fn purge_stale_webview_cache_on_build_change(
    app: &tauri::AppHandle,
    identifier: &str,
    current_version: &str,
    startup_log: &Option<PathBuf>,
) {
    let current_build = webview_build_identity(current_version);
    let marker_path = last_run_version_marker(app);
    let last = marker_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let last_trimmed = last.as_ref().map(|s| s.trim());

    if !should_purge_webview_cache(last_trimmed, &current_build) {
        return;
    }

    log_startup(
        startup_log,
        format!(
            "webview-cache-purge: packaged-build change {:?} -> {} — purging stale caches (preserving Local Storage/IndexedDB/cookies)",
            last_trimmed, current_build
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
        if let Err(e) = std::fs::write(&path, &current_build) {
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
        // 'grok' is now the OAuth (subscription) Grok id; 'xai'/'x-ai' stay the API-key Grok. (Mirrors the JS registry.)
        "grok" | "grok-oauth" | "xai-oauth" => "grok",
        "kimi" | "moonshot" | "kimi-code" | "kimi-oauth" => "kimi",
        "xai" | "x-ai" => "xai",
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

/// Delete a keychain credential, treating "nothing stored" as success. A REAL deletion
/// failure (locked keychain, OS error) surfaces as Err so callers can stop claiming
/// "purged" while the secret lives on — truthful telemetry applies to destruction too.
fn delete_credential_honest(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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
            // Store into the keychain if it doesn't already hold this channel's token (idempotent re-runs).
            if read_channel_token(channel).is_none() {
                if let Ok(entry) = channel_keychain_entry(channel) {
                    let _ = entry.set_password(&token);
                }
            }
            // INVARIANT (Andrew): never remove the last copy of a secret without PROOF a durable home holds it.
            // Only strip the plaintext token once read_channel_token() confirms the keychain actually has it. If the
            // set_password above failed (locked keychain, permissions, no backend), leave the plaintext token in
            // place — a token on disk is strictly better than a lost token. Best-effort; never blocks startup. The
            // sidecar's own boot migration will re-attempt the keychain adoption on a later launch (self-healing).
            let keychain_has_it = read_channel_token(channel)
                .map(|t| t == token)
                .unwrap_or(false);
            if keychain_has_it {
                if let Some(rec) = json.get_mut(channel).and_then(|r| r.as_object_mut()) {
                    rec.remove("token");
                    changed = true;
                }
            }
        }
    }
    if changed {
        if let Ok(serialized) = serde_json::to_string(&json) {
            // Atomic rewrite: a crash mid-write of secrets.json must never leave a truncated
            // file (would corrupt the channel config). Write a sibling temp, then rename over
            // the target — rename is atomic on the same volume, so readers see all-or-nothing.
            let _ = atomic_write(&file, serialized.as_bytes());
        }
    }
}

/// Write `bytes` to `path` crash-safely: land them in a sibling temp file, flush, then
/// atomically rename over `path`. The temp lives in the SAME directory so the rename stays on
/// one volume (cross-volume renames are not atomic and can fall back to copy+delete). A crash
/// before the rename leaves the temp (harmless orphan) and the original untouched; a crash
/// after leaves the fully-written new file. Best-effort — errors bubble to the caller to log/ignore.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    // Unique-ish temp name in the same dir; the pid keeps concurrent writers from colliding.
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("secrets.json"),
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
        let _ = f.sync_all();
    }
    // On Windows, rename fails if the destination exists; remove-then-rename is the pragmatic
    // path (there is a tiny window with no file, but a crash there still leaves the temp intact
    // for a manual recover, and the sidecar's own resilient loader tolerates a missing file).
    #[cfg(windows)]
    {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
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

// ---- boot-time orphan-sidecar reap -------------------------------------------------------
//
// ESCAPE (2026-07-08): killing the shell hard (`taskkill /F`, crash, task-manager End Task)
// never runs `Drop for AppState` / the ExitRequested handler, so the spawned node.exe sidecar
// survives as an orphan. Multiple live sidecars sharing one WORKSPACES dir break the hard
// one-sidecar-per-WORKSPACES invariant (durable-store safety is in-process only), and Codex
// OAuth refresh-token rotation means two sidecars sharing one token file consume each other's
// tokens ("refresh token already consumed by another client"). Three stale sidecars were found
// alive on a real machine. There is no reliable in-process hook on a hard kill — so the
// RELIABLE half of the fix is here: every boot, BEFORE spawning our own sidecar, terminate any
// process still running from the shell's OWN bundled node runtime.

/// Pure predicate: is `node` a path we may reap by? Only the shell's own bundled runtime
/// qualifies — an absolute path (packaged builds resolve `<install dir>\node.exe`). The dev
/// fallback `node_binary()` returns (`PathBuf::from("node")`, resolved via PATH) is relative,
/// and reaping by it would pattern-match EVERY node.exe on the system (dev servers, other
/// apps). Kept side-effect-free so it is unit-testable.
fn is_reapable_node_path(node: &Path) -> bool {
    node.is_absolute() && node.file_name().is_some()
}

/// Terminate every running process whose executable image is EXACTLY `node` — the same path
/// this shell spawns its sidecar from (never a generic "node.exe" name match). Returns how
/// many were reaped. Fail-open by design: any enumeration/open/query/terminate error skips
/// that process and never blocks startup.
#[cfg(windows)]
fn reap_orphan_sidecars(node: &Path, startup_log: &Option<PathBuf>) -> usize {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, MAX_PATH};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    if !is_reapable_node_path(node) {
        log_startup(
            startup_log,
            format!(
                "sidecar-reap: skipped — node path {:?} is not an absolute bundled runtime (dev PATH fallback)",
                node
            ),
        );
        return 0;
    }
    // File-name prefilter (cheap, from the snapshot) before the full-image-path check.
    let node_file_name = node
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        log_startup(startup_log, "sidecar-reap: snapshot failed — skipped (fail-open)");
        return 0;
    }

    let mut reaped = 0usize;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let exe_name = {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase()
        };
        if exe_name == node_file_name && entry.th32ProcessID != std::process::id() {
            let pid = entry.th32ProcessID;
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                    0,
                    pid,
                )
            };
            if !handle.is_null() {
                // Full image path — the ONLY thing that authorizes a kill. A node.exe running
                // from anywhere else (system PATH, another app's bundle) is never touched.
                let mut buf = [0u16; MAX_PATH as usize + 1];
                let mut size = buf.len() as u32;
                let got =
                    unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
                if got != 0 {
                    let full = PathBuf::from(String::from_utf16_lossy(&buf[..size as usize]));
                    if same_path(&full, node) {
                        if unsafe { TerminateProcess(handle, 1) } != 0 {
                            reaped += 1;
                            log_startup(
                                startup_log,
                                format!(
                                    "sidecar-reap: terminated orphan sidecar pid={pid} ({})",
                                    full.display()
                                ),
                            );
                        } else {
                            log_startup(
                                startup_log,
                                format!("sidecar-reap: TerminateProcess failed for pid={pid} — skipped (fail-open)"),
                            );
                        }
                    }
                }
                unsafe {
                    CloseHandle(handle);
                }
            }
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    log_startup(
        startup_log,
        format!(
            "sidecar-reap: done — {reaped} orphan sidecar(s) reaped for {}",
            node.display()
        ),
    );
    reaped
}

/// Non-Windows: no reap wired yet (the observed orphan escape is Windows taskkill /F; mac/linux
/// hard kills of the shell can strand a sidecar the same way — hook a pgrep-by-exact-path pass
/// in here when a case is observed). Honest no-op, logged.
#[cfg(not(windows))]
fn reap_orphan_sidecars(node: &Path, startup_log: &Option<PathBuf>) -> usize {
    let _ = node;
    log_startup(
        startup_log,
        "sidecar-reap: non-Windows platform — no reap wired yet",
    );
    0
}

fn sidecar_command(state: &AppState, entry: &Path, node: &Path) -> Command {
    let mut cmd = Command::new(node);
    cmd.arg(entry)
        .env("SKYNET_PORT", state.port.to_string())
        .env("SKYNET_IPC_TOKEN", &state.ipc_token)
        .env("SKYNET_API_TOKEN", &state.api_token)
        .env("STARNET_WORKSPACES", state.workspaces.as_os_str())
        .env("SKYNET_WORKSPACES", state.workspaces.as_os_str())
        // The sidecar can load the native Windows desktop driver, but that alone grants nothing:
        // only a locally paired Telegram owner receives the per-run remote-owner lease. Ordinary
        // agent runs remain synthetic/headless by policy in the sidecar.
        .env("STARNET_DESKTOP_SHELL", "1")
        .env("STARNET_COMPUTER_DRIVER", "1")
        .env("STARNET_BROWSER_HEADLESS", "1")
        .env("STARNET_USER_CONTROL_MODE", "preserve")
        .env("STARNET_MCP_STDIO", "0")
        // The packaged build's true version — computeVersionSurface() reads this first, so
        // /api/diagnostics reports the real build instead of "unknown" (the bundled sidecar
        // has no src-tauri/tauri.conf.json to fall back to). CARGO_PKG_VERSION is the
        // compile-time Cargo.toml version, kept in lockstep with tauri.conf.json by release-bump.
        .env("STARNET_APP_VERSION", env!("CARGO_PKG_VERSION"))
        // The exact source this desktop was compiled from (build.rs → `git describe --always --dirty --tags`,
        // e.g. "v0.4.1" clean or "v0.4.1-32-g8b5aae04-dirty"). Exported so the bundled sidecar can surface the
        // real build provenance at /api/version — a packaged app has no .git to derive it from at runtime.
        .env("STARNET_BUILD_DESCRIBE", env!("STARNET_BUILD_DESCRIBE"))
        // Full immutable source identity for installed-smoke/release receipts. Keep this separate from the
        // short human-facing commit exposed by starnet_build_info.
        .env("STARNET_BUILD_SHA", env!("STARNET_BUILD_SHA"))
        .env("STARNET_BUILD_TREE", env!("STARNET_BUILD_TREE"))
        .env(
            "STARNET_BUILD_PROVENANCE_KIND",
            env!("STARNET_BUILD_PROVENANCE_KIND"),
        )
        .env("STARNET_BUILD_DIRTY", env!("STARNET_BUILD_DIRTY"))
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

/// Startup-failure dialog (audit 0.2). When the FIRST `spawn_sidecar` fails — e.g. a first-run
/// user whose bundled node was blocked by antivirus/Application-Control — the window would
/// otherwise open dead with every /api fetch failing, no explanation, no way back. This surfaces
/// a native error box that names the startup.log path (the diagnostic) and offers Retry.
///
/// Returns `true` if the user chose Retry (caller should re-attempt the spawn), `false` on
/// Cancel/close. On non-Windows there is no dialog dependency wired, so we log and return `false`
/// (honest degradation — the AV-block scenario this fixes is Windows-specific).
#[cfg(windows)]
fn show_startup_failure_dialog(startup_log: &Option<PathBuf>) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDRETRY, MB_ICONERROR, MB_RETRYCANCEL, MB_SETFOREGROUND, MB_SYSTEMMODAL,
    };
    let log_line = match startup_log {
        Some(p) => format!("Details were written to:\n{}", p.display()),
        None => "No startup log path was available.".to_string(),
    };
    let body = format!(
        "StarNet could not start its local engine.\n\n\
         This usually means the bundled Node runtime was blocked by antivirus or a Windows \
         Application Control policy, or the port could not be opened.\n\n\
         {log_line}\n\n\
         Click Retry to try starting the engine again, or Cancel to close StarNet."
    );
    let to_wide = |s: &str| -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    };
    let text = to_wide(&body);
    let caption = to_wide("StarNet — startup failed");
    // SYSTEMMODAL + SETFOREGROUND so the box is seen even though the main window isn't up yet.
    let result = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_RETRYCANCEL | MB_ICONERROR | MB_SETFOREGROUND | MB_SYSTEMMODAL,
        )
    };
    result == IDRETRY
}

#[cfg(not(windows))]
fn show_startup_failure_dialog(startup_log: &Option<PathBuf>) -> bool {
    log_startup(
        startup_log,
        "startup failed: sidecar did not come up and no native dialog is wired on this platform",
    );
    eprintln!("[starnet] startup failed: sidecar did not come up (see startup.log)");
    false
}

/// Spawn the sidecar and, if it fails to come up, loop showing the startup-failure dialog so the
/// user can Retry (audit 0.2). Bounded so a persistently-blocked node can't spin a dialog forever:
/// after the retries are exhausted we return `false` and let the guardian keep trying in the
/// background. Returns `true` once the sidecar is listening.
fn spawn_sidecar_with_retry(state: &AppState) -> bool {
    // A handful of user-driven retries at startup; the long-lived guardian covers the rest.
    for _ in 0..5 {
        if spawn_sidecar(state) {
            return true;
        }
        if !show_startup_failure_dialog(&state.startup_log) {
            // User chose Cancel — stop prompting; the guardian may still recover it silently.
            return false;
        }
        log_startup(&state.startup_log, "startup: user chose Retry — respawning sidecar");
    }
    log_startup(
        &state.startup_log,
        "startup: retries exhausted; leaving recovery to the guardian",
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
        // Tracks consecutive failed respawns while the sidecar is absent so we back off instead of
        // hammering a permanently-blocked node (audit 0.2: recover even from the None state, but
        // bounded). Reset to 0 whenever the sidecar is confirmed alive.
        let mut consecutive_failures: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let st: &AppState = state.inner();
            if st.shutting_down.load(Ordering::SeqCst) {
                break;
            }

            // Decide under the lock, respawn after releasing it — spawn_sidecar takes the same lock
            // itself, so respawning while holding it would deadlock. `needs_respawn` covers TWO cases:
            //   (a) a child exists but has exited unexpectedly (crash/OOM), and
            //   (b) NO child exists at all — the initial spawn never succeeded (e.g. AV-blocked node).
            // Case (b) is the audit-0.2 fix: previously the guardian only ever healed (a), so a
            // first-run spawn failure left the app permanently dead with no background recovery.
            let mut needs_respawn = false;
            let mut from_none = false;
            if let Ok(mut guard) = st.sidecar.lock() {
                match guard.as_mut() {
                    Some(child) => {
                        if let Ok(Some(_status)) = child.try_wait() {
                            needs_respawn = true; // (a) crashed
                        } else {
                            consecutive_failures = 0; // alive and running
                        }
                    }
                    None => {
                        needs_respawn = true; // (b) never came up
                        from_none = true;
                    }
                }
            }
            if needs_respawn {
                // Re-check the flag: an intentional quit may have landed between the poll and now.
                if st.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                // Back off the never-came-up case: after a few quick tries, poll far less often so a
                // genuinely blocked node doesn't burn a core. A crash-respawn (Some, exited) always
                // gets an immediate attempt — that path had a working node moments ago.
                if from_none && consecutive_failures >= 5 {
                    // Slow path: ~30s between attempts once we've clearly failed to launch repeatedly.
                    if consecutive_failures % 10 != 0 {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        continue;
                    }
                }
                log_startup(
                    &st.startup_log,
                    if from_none {
                        "watchdog: sidecar never came up — attempting respawn"
                    } else {
                        "watchdog: sidecar exited unexpectedly — respawning"
                    },
                );
                if spawn_sidecar(st) {
                    consecutive_failures = 0;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                }
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

// ---- Lane 4D: supervised background lifecycle (tray + close-to-tray + bounded drain) ----
//
// The tray owns the ONE sidecar's visibility contract: closing the window keeps the station running ONLY when
// the sidecar proves armed work exists (GET /api/lifecycle/armed), and that state is explicit in the tray. If
// nothing is armed, window-close = full quit (drain + kill + app.exit) — no hidden daemon. Every decision reads
// LIVE sidecar truth; a poll failure degrades to "not armed" (a dead sidecar can't be doing background work, so
// a full quit is the safe + honest choice).

/// The classified outcome of one lifecycle poll. The DISTINCTION matters for the close decision (M2):
/// a refused TCP connect proves no sidecar is listening — nothing armed can exist, quitting is safe. But a
/// connect that SUCCEEDS and then times out / returns garbage means the sidecar is ALIVE but slow or unwell —
/// killing it on that evidence could destroy armed background work, so those cases must fail OPEN (keep the
/// process; the tray keeps polling until the status recovers).
enum LifecycleProbe {
    /// TCP connect failed — no sidecar is listening on the port. Safe to fully quit.
    NotRunning,
    /// Connect succeeded but the poll didn't produce a valid 200 snapshot (read timeout, non-200, malformed
    /// body). The sidecar is alive; its armed state is UNKNOWN — never treat this as "not armed".
    Ambiguous,
    /// A valid 200 snapshot — the sidecar's own truthful account.
    Armed(LifecycleArmed),
}

/// Pure parser for the raw HTTP response text of GET /api/lifecycle/armed. None = not a valid 200 snapshot
/// (callers classify that as Ambiguous). Kept side-effect-free so it is unit-testable (M3).
fn parse_lifecycle_response(text: &str) -> Option<LifecycleArmed> {
    // Status line must be 200; the body is the JSON after the header/body blank line.
    let status_line = text.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return None;
    }
    let body = text.split("\r\n\r\n").nth(1)?;
    let json: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    // `armed` must be PRESENT and boolean — a 200 without it is not our snapshot (never default to false
    // here: the caller would translate that into "safe to kill").
    let armed = json.get("armed").and_then(|v| v.as_bool())?;
    let reasons = json
        .get("reasons")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some(LifecycleArmed { armed, reasons })
}

/// Blocking poll of GET /api/lifecycle/armed, classified per LifecycleProbe. Uses the per-launch API token as
/// the X-StarNet-Token header (the same gate the frontend fetches use); no Origin header (absent Origin is
/// allowed for loopback callers).
fn probe_lifecycle_armed(port: u16, api_token: &str, timeout: Duration) -> LifecycleProbe {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return LifecycleProbe::NotRunning;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let head = format!(
        "GET /api/lifecycle/armed HTTP/1.1\r\nHost: 127.0.0.1\r\nX-StarNet-Token: {api_token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() || stream.flush().is_err() {
        return LifecycleProbe::Ambiguous; // connected, then failed — alive but unwell
    }
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw); // a timeout mid-read still yields what arrived; parse decides
    let text = String::from_utf8_lossy(&raw);
    match parse_lifecycle_response(&text) {
        Some(l) => LifecycleProbe::Armed(l),
        None => LifecycleProbe::Ambiguous,
    }
}

/// Back-compat convenience for surfaces that only need the snapshot when one is available (the frontend
/// status command). The close decision must NOT use this — it needs the full classification above.
fn query_lifecycle_armed(port: u16, api_token: &str, timeout: Duration) -> Option<LifecycleArmed> {
    match probe_lifecycle_armed(port, api_token, timeout) {
        LifecycleProbe::Armed(l) => Some(l),
        _ => None,
    }
}

/// POST /api/halt (the E-STOP) to the running sidecar, bounded by `timeout`. Aborts every in-flight run,
/// releases the cron lock, and reaps backend-owned background processes — so no unattended spend outlives the
/// action. Best-effort: a dead sidecar or timeout is a no-op (nothing to halt). API-token guarded like the UI.
fn post_sidecar_halt(state: &AppState, timeout: Duration) {
    use std::io::{Read, Write};
    let body = "{}";
    let head = format!(
        "POST /api/halt HTTP/1.1\r\nHost: 127.0.0.1\r\nX-StarNet-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.api_token,
        body.len()
    );
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", state.port)) {
        let _ = s.set_read_timeout(Some(timeout));
        let _ = s.set_write_timeout(Some(timeout));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(body.as_bytes());
        let _ = s.flush();
        let mut buf = [0u8; 64];
        let _ = s.read(&mut buf);
    }
}

/// Bounded drain, then kill: flip `shutting_down` so the guardian never respawns, ask the sidecar to halt all
/// in-flight work (bounded), then terminate the child. The halt gives unattended runs a clean stop before the
/// process dies; the kill guarantees no orphan sidecar outlives an explicit Quit.
fn drain_and_kill_sidecar(state: &AppState) {
    state.shutting_down.store(true, Ordering::SeqCst);
    post_sidecar_halt(state, Duration::from_secs(3));
    state.kill_sidecar();
}

/// Reveal + focus the main window (from a hidden/close-to-tray state or a minimized one).
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Tray menu dispatch. Open reveals the window; Pause Automation fires the E-STOP so background work stops even
/// with the window closed; Quit drains + kills the sidecar and exits the app (no daemon left behind).
/// Pause/Quit run their bounded network work on a worker thread — tray menu events arrive on the main loop and
/// a multi-second drain there would freeze the app (review m1).
fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "lifecycle_open" => show_main_window(app),
        "lifecycle_pause" => {
            let app2 = app.clone();
            std::thread::spawn(move || {
                if let Some(state) = app2.try_state::<AppState>() {
                    post_sidecar_halt(state.inner(), Duration::from_secs(3));
                }
            });
        }
        "lifecycle_quit" => {
            let app2 = app.clone();
            std::thread::spawn(move || {
                if let Some(state) = app2.try_state::<AppState>() {
                    drain_and_kill_sidecar(state.inner());
                }
                app2.exit(0);
            });
        }
        _ => {}
    }
}

/// Background thread keeping the tray tooltip + status line HONEST: every few seconds it re-polls the sidecar's
/// armed truth and re-renders the tray. When idle it says so ("closing quits"); when armed it lists the real
/// reasons. Stops when the app is shutting down. A poll failure renders the idle/unknown state, never a stale
/// "still working" claim.
fn spawn_tray_updater(app: AppHandle) {
    std::thread::spawn(move || loop {
        // Poll FIRST, sleep after (review m2): the menu is built with a non-committal "checking…" line, and an
        // immediate first poll replaces it with real state before a user can plausibly open the tray — the tray
        // must never assert a stale claim.
        if let Some(state) = app.try_state::<AppState>() {
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let probe = probe_lifecycle_armed(state.port, &state.api_token, Duration::from_millis(1500));
            let (tooltip, status_text) = match probe {
                LifecycleProbe::Armed(l) if l.armed => {
                    let summary = if l.reasons.is_empty() {
                        "running in the background".to_string()
                    } else {
                        l.reasons.join(", ")
                    };
                    (
                        format!("StarNet — {summary}"),
                        format!("Background: {summary}"),
                    )
                }
                LifecycleProbe::Armed(_) | LifecycleProbe::NotRunning => (
                    // Nothing armed (or no engine at all): closing quits — the same rule the close path applies.
                    "StarNet — idle (closing quits)".to_string(),
                    "Background: idle — closing quits".to_string(),
                ),
                LifecycleProbe::Ambiguous => (
                    // Alive but the poll failed — honest "unknown", mirroring the close path's fail-open.
                    "StarNet — status unavailable (close keeps it running)".to_string(),
                    "Background: status unavailable — close keeps it running".to_string(),
                ),
            };
            if let Some(tray) = app.tray_by_id("starnet-tray") {
                let _ = tray.set_tooltip(Some(tooltip.as_str()));
            }
            if let Some(handles) = app.try_state::<TrayHandles>() {
                let _ = handles.status.set_text(status_text.as_str());
            }
        }
        std::thread::sleep(Duration::from_secs(4));
    });
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
        // codex + the device-OAuth providers (grok/kimi) authenticate by OAuth token (sidecar-owned), not a
        // keychain API key; ollama is keyless. None of them get a keychain entry.
        if provider_id != "codex" && provider_id != "ollama" && provider_id != "grok" && provider_id != "kimi" {
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
    let trimmed = token.trim();
    if !is_known_channel(&channel) {
        // Clearing (empty token) a channel this shell never keychains is vacuously done — nothing was ever
        // stored under its namespace, so FORGET must not report a phantom keychain failure for it. STORING
        // a token for an unknown channel stays an error (defends the keychain account namespace).
        if trimmed.is_empty() {
            return Ok(());
        }
        return Err(format!("unknown channel: {channel}"));
    }
    let entry = channel_keychain_entry(&channel).map_err(|e| e.to_string())?;
    if trimmed.is_empty() {
        // FORGET path: a swallowed deletion failure here let the UI claim "purged" while the token
        // survived in the OS keychain. A real failure now surfaces to the caller (NoEntry is fine).
        delete_credential_honest(&entry)?;
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

/// Windows/tao: set_fullscreen(true) on a MAXIMIZED window keeps the maximized
/// work-area geometry (screen minus taskbar) — a dead strip stays along the bottom
/// and the layout mis-sizes. Remember the maximize across the fullscreen span so
/// exit restores it.
static FS_RESTORE_MAXIMIZE: AtomicBool = AtomicBool::new(false);

/// Toggle the main StarNet desktop window between windowed and fullscreen mode.
#[tauri::command]
fn starnet_toggle_fullscreen(app: AppHandle) -> Result<bool, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    let next = !win.is_fullscreen().map_err(|e| e.to_string())?;
    if next {
        let was_max = win.is_maximized().unwrap_or(false);
        FS_RESTORE_MAXIMIZE.store(was_max, Ordering::Relaxed);
        if was_max {
            let _ = win.unmaximize();
        }
    }
    win.set_fullscreen(next).map_err(|e| e.to_string())?;
    if !next && FS_RESTORE_MAXIMIZE.swap(false, Ordering::Relaxed) {
        let _ = win.maximize();
    }
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
    // WINDOWS UPDATE-HANG FIX (canary-proven 2026-07-14): the NSIS installer the updater
    // launches must overwrite the bundled node.exe — but our sidecar is STILL RUNNING from
    // that same node runtime, so it holds a write lock and NSIS freezes on an "error opening
    // file for writing" dialog forever. The plugin exits via std::process::exit(0), which
    // does NOT fire Tauri's ExitRequested handler where kill_sidecar() normally runs — so
    // without this hook the sidecar is never reaped before the installer touches node.exe.
    // on_before_exit runs immediately before that process exit: stop the guardian respawn and
    // kill the child so node.exe is unlocked when NSIS arrives. The Update object built here
    // carries this hook into the install path (the plugin clones it onto the pending update).
    let app_for_exit = app.clone();
    let update = app
        .updater_builder()
        .on_before_exit(move || {
            if let Some(state) = app_for_exit.try_state::<AppState>() {
                state.shutting_down.store(true, Ordering::SeqCst);
                state.kill_sidecar();
            }
        })
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
    sha: String,
    #[serde(rename = "sourceTree")]
    source_tree: String,
    #[serde(rename = "provenanceKind")]
    provenance_kind: String,
    describe: String,
    dirty: bool,
    #[serde(rename = "executableSha256")]
    executable_sha256: String,
    #[serde(rename = "executableSize")]
    executable_size: u64,
}

/// Hash an executable without loading it wholesale into memory. The identity is intentionally
/// content-only: installed-smoke can bind the operator-supplied artifact to the bytes that are
/// actually running without exposing the user's install path to the WebView/evidence bundle.
fn executable_identity(path: &Path) -> Option<(String, u64)> {
    let mut file = std::fs::File::open(path).ok()?;
    let expected_size = file.metadata().ok()?.len();
    if expected_size == 0 {
        return None;
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes_read = 0_u64;
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes_read = bytes_read.checked_add(count as u64)?;
    }
    if bytes_read != expected_size {
        return None;
    }
    Some((format!("{:x}", hasher.finalize()), bytes_read))
}

fn runtime_executable_identity() -> (String, u64) {
    static IDENTITY: OnceLock<(String, u64)> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| executable_identity(&path))
                .unwrap_or_else(|| (String::new(), 0))
        })
        .clone()
}

#[cfg(test)]
mod executable_identity_tests {
    use super::executable_identity;

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-executable-identity-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn hashes_exact_file_bytes_and_size() {
        let file = temp_file("nonempty.bin");
        std::fs::write(&file, b"abc").unwrap();

        let identity = executable_identity(&file).expect("non-empty file has an identity");
        assert_eq!(
            identity,
            (
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_string(),
                3
            )
        );

        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn refuses_empty_or_missing_files() {
        let empty = temp_file("empty.bin");
        std::fs::write(&empty, []).unwrap();
        assert_eq!(executable_identity(&empty), None);
        let _ = std::fs::remove_file(&empty);
        assert_eq!(executable_identity(&empty), None);
    }
}

#[tauri::command]
fn starnet_build_info(app: AppHandle) -> BuildInfo {
    let (executable_sha256, executable_size) = runtime_executable_identity();
    BuildInfo {
        version: app.package_info().version.to_string(),
        commit: env!("STARNET_BUILD_COMMIT").to_string(),
        sha: env!("STARNET_BUILD_SHA").to_string(),
        source_tree: env!("STARNET_BUILD_TREE").to_string(),
        provenance_kind: env!("STARNET_BUILD_PROVENANCE_KIND").to_string(),
        describe: env!("STARNET_BUILD_DESCRIBE").to_string(),
        dirty: env!("STARNET_BUILD_DIRTY") == "1",
        executable_sha256,
        executable_size,
    }
}

/// Lane 4D: is launch-at-login currently registered? OPT-IN, default OFF — this only reports the real OS state
/// (Windows Run key / macOS LaunchAgent / Linux autostart .desktop) so the Settings toggle never lies.
#[tauri::command]
fn starnet_autostart_status(app: AppHandle) -> Result<AutostartStatus, String> {
    use tauri_plugin_autostart::ManagerExt;
    let enabled = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
    Ok(AutostartStatus {
        desktop: true,
        enabled,
    })
}

/// Enable/disable launch-at-login and report the resulting REAL state (read back, not assumed). The single-
/// instance plugin guarantees a login launch focuses the running app rather than starting a 2nd sidecar.
#[tauri::command]
fn starnet_set_autostart(app: AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    let now = manager.is_enabled().map_err(|e| e.to_string())?;
    Ok(AutostartStatus {
        desktop: true,
        enabled: now,
    })
}

/// Lane 4D: the live armed-work summary for the frontend's background-lifecycle surface. Proxies the sidecar's
/// own truth through the supervisor so the UI's "what keeps running when you close the window" copy is gated on
/// the SAME state the tray's close decision uses — never a divergent claim.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleView {
    supervised: bool,
    armed: bool,
    reasons: Vec<String>,
}

#[tauri::command]
fn starnet_lifecycle_status(state: State<AppState>) -> LifecycleView {
    match query_lifecycle_armed(state.port, &state.api_token, Duration::from_millis(1500)) {
        Some(l) => LifecycleView {
            supervised: true,
            armed: l.armed,
            reasons: l.reasons,
        },
        None => LifecycleView {
            supervised: true,
            armed: false,
            reasons: Vec::new(),
        },
    }
}

fn main() {
    tauri::Builder::default()
        // A second launch should focus the running window, not spin up a 2nd sidecar. Registered FIRST per
        // Tauri guidance (n1): single-instance must run before other plugins so a second process bails early.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show(); // the window may be hidden in the tray — a relaunch should reveal it
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        // Lane 4D: launch-at-login (opt-in, default OFF). macOS uses a LaunchAgent; Windows a Run key; Linux an
        // autostart .desktop. Registered here so the ManagerExt API is available; the toggle lives in Settings.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
            starnet_build_info,
            starnet_autostart_status,
            starnet_set_autostart,
            starnet_lifecycle_status
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
                &startup_log,
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
            // Before spawning OUR sidecar: terminate any orphan sidecars left behind by a
            // hard-killed previous shell (Drop/ExitRequested never ran there). Multiple live
            // sidecars on one WORKSPACES dir violate the one-sidecar invariant and burn each
            // other's rotating Codex OAuth refresh tokens. Scoped strictly to processes whose
            // image path IS our bundled node runtime; fail-open, never blocks startup.
            reap_orphan_sidecars(&node_binary(&state.root), &state.startup_log);
            // Try to bring the sidecar up; on failure show a native Retry dialog naming startup.log
            // (audit 0.2). Even if this ultimately returns false, the guardian below keeps trying so
            // the app can still recover in the background rather than sitting permanently dead.
            let _ = spawn_sidecar_with_retry(&state);
            app.manage(state);
            app.manage(PendingUpdate(Mutex::new(None)));

            // Respawn the sidecar if it crashes while the window is open (see spawn_guardian).
            spawn_guardian(app.handle().clone());

            // ---- Lane 4D: tray supervisor ----
            // The tray is the visible owner of the background-lifecycle contract. Open reveals the window; the
            // status line reflects REAL armed work (kept honest by spawn_tray_updater); Pause Automation fires
            // the E-STOP (reaches background work even with the window closed); Quit drains + kills the sidecar
            // and exits. Built here so it exists before the window, so a close-to-tray has somewhere to live.
            {
                let open_item = MenuItem::with_id(app, "lifecycle_open", "Open StarNet", true, None::<&str>)?;
                let status_item = MenuItem::with_id(
                    app,
                    "lifecycle_status",
                    // Non-committal until the FIRST real poll lands (spawn_tray_updater polls immediately) —
                    // the tray must never assert an armed/idle claim it hasn't read from the sidecar (m2).
                    "Background: checking…",
                    false, // a non-clickable live status line, not an action
                    None::<&str>,
                )?;
                let pause_item = MenuItem::with_id(app, "lifecycle_pause", "Pause Automation (E-STOP)", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "lifecycle_quit", "Quit StarNet", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let menu = Menu::with_items(app, &[&open_item, &status_item, &sep, &pause_item, &quit_item])?;
                let mut tray_builder = TrayIconBuilder::with_id("starnet-tray")
                    .tooltip("StarNet")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
                    .on_tray_icon_event(|tray, event| {
                        // A left click on the tray icon reveals the window (the expected "bring it back" gesture).
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }
                tray_builder.build(app)?;
                app.manage(TrayHandles { status: status_item });
                // Keep the tray tooltip/status honest against live sidecar truth.
                spawn_tray_updater(app.handle().clone());
            }

            // The frontend is served LOCALLY (bundled via frontendDist), NOT from the sidecar's
            // http origin — Tauri denies IPC (the keychain commands) to remote origins. This shim
            // rewrites the frontend's root-relative /api/* fetches to the sidecar's port.
            let init = format!(
                "window.__STARNET_API__='http://127.0.0.1:{port}';window.__STARNET_API_TOKEN__='{api_token}';var _sf=window.fetch;window.fetch=function(u,o){{if(typeof u==='string'&&u.indexOf('/api/')===0)u=window.__STARNET_API__+u;return _sf(u,o)}};"
            );
            // Windows runs WITHOUT native decorations (see the window builder below): this flag
            // tells the frontend (app/titlebar.js) to render its own themed titlebar with
            // MIN/MAX/CLOSE riding the Commander's phosphor theme. macOS/browser never set it.
            #[cfg(windows)]
            let init = format!("{init}window.__STARNET_CUSTOM_CHROME__=1;");

            // Purge stale WebView2 compiled/GPU caches when the packaged build changed, BEFORE the
            // webview window is created — otherwise V8 can run old bytecode against new data
            // (see docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md P0.1). Fails soft; never blocks boot.
            {
                let handle = app.handle();
                let identifier = handle.config().identifier.clone();
                let current_version = handle.package_info().version.to_string();
                let log = startup_log_path(handle);
                purge_stale_webview_cache_on_build_change(
                    handle,
                    &identifier,
                    &current_version,
                    &log,
                );
            }

            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("StarNet")
                .inner_size(1280.0, 832.0)
                .min_inner_size(960.0, 600.0)
                .initialization_script(&init)
                .center()
                .visible(false)
                // Reveal only after the document paints — avoids a white flash.
                .on_page_load(|window, _payload| {
                    let _ = window.show();
                });
            // Windows: drop the stock titlebar/border — the frontend draws its own themed
            // chrome (titlebar.js, gated on __STARNET_CUSTOM_CHROME__ above). shadow(true)
            // keeps the DWM drop shadow, and Tauri's undecorated-resize handling keeps the
            // edge-drag resize grips working. macOS keeps native decorations until a mac
            // pass is designed (unverified there — do not blind-apply).
            #[cfg(windows)]
            let main_window = main_window.decorations(false).shadow(true);
            let main_window = main_window.build()?;

            // ---- Lane 4D: close-to-tray, gated on REAL armed work ----
            // On a close request: ALWAYS intercept + hide immediately (instant feedback, and the poll must not
            // block the UI thread — review m1), then decide on a worker thread from the classified probe (M2):
            //   Armed{armed:true}  -> keep the ONE sidecar running, window lives in the tray (explicit there).
            //   Armed{armed:false} -> nothing armed: drain + kill + exit — full quit, NO background process.
            //   NotRunning         -> connect refused: no sidecar is listening, so no armed work can exist —
            //                         full quit is safe (this is the ONLY failure that may quit).
            //   Ambiguous (x2)     -> the sidecar ACCEPTED the connection but the poll failed (slow/garbled):
            //                         it is ALIVE and may hold armed work — killing it on that evidence could
            //                         destroy the work, so after one retry we FAIL OPEN: stay hidden in the
            //                         tray and let the updater keep polling until the status recovers.
            // This is the whole product promise: no hidden daemon, and no claim the harness can't prove.
            {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                        let app2 = app_handle.clone();
                        std::thread::spawn(move || {
                            let Some(state) = app2.try_state::<AppState>() else {
                                app2.exit(0);
                                return;
                            };
                            let st = state.inner();
                            let mut probe = probe_lifecycle_armed(
                                st.port,
                                &st.api_token,
                                Duration::from_millis(1500),
                            );
                            if matches!(probe, LifecycleProbe::Ambiguous) {
                                // One retry before deciding — a single slow poll must not park the app in the
                                // tray forever when the sidecar is actually healthy and idle.
                                probe = probe_lifecycle_armed(
                                    st.port,
                                    &st.api_token,
                                    Duration::from_millis(1500),
                                );
                            }
                            match probe {
                                LifecycleProbe::Armed(l) if l.armed => { /* stay hidden in the tray */ }
                                LifecycleProbe::Ambiguous => { /* alive but unwell — fail OPEN, stay in tray */ }
                                _ => {
                                    // Armed{armed:false} or NotRunning: window-close is a full quit.
                                    drain_and_kill_sidecar(st);
                                    app2.exit(0);
                                }
                            }
                        });
                    }
                });
            }

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
mod sidecar_reap_tests {
    use super::*;

    #[test]
    fn dev_path_fallback_is_never_reapable() {
        // node_binary()'s dev fallback is a bare relative "node" resolved via PATH. Reaping by
        // it would match EVERY node.exe on the machine — must be refused.
        assert!(!is_reapable_node_path(Path::new("node")));
        assert!(!is_reapable_node_path(Path::new("node.exe")));
        assert!(!is_reapable_node_path(Path::new("bin/node.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn bundled_absolute_path_is_reapable() {
        assert!(is_reapable_node_path(Path::new(
            r"C:\Program Files\StarNet\node.exe"
        )));
    }

    #[cfg(not(windows))]
    #[test]
    fn bundled_absolute_path_is_reapable() {
        assert!(is_reapable_node_path(Path::new("/opt/starnet/node")));
    }

    /// Ambient end-to-end proof (spawns and terminates REAL processes) — excluded from the
    /// default test run; execute explicitly with `cargo test -- --ignored`. Copies node.exe to
    /// a unique temp "bundled" path, starts one process from it (the orphan) and one from the
    /// system node (the bystander), then asserts the reap kills exactly the former.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reap_terminates_only_processes_from_the_exact_path() {
        let node_on_path = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|d| d.join("node.exe"))
                .find(|p| p.exists())
        });
        let Some(src) = node_on_path else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!(
            "starnet-reap-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join("node.exe");
        std::fs::copy(&src, &bundled).unwrap();

        let idle = ["-e", "setInterval(function(){}, 1000)"];
        let mut orphan = Command::new(&bundled).args(idle).spawn().unwrap();
        let mut bystander = Command::new(&src).args(idle).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(400));

        let reaped = reap_orphan_sidecars(&bundled, &None);
        assert!(reaped >= 1, "expected at least the planted orphan to be reaped");

        std::thread::sleep(Duration::from_millis(400));
        assert!(
            matches!(orphan.try_wait(), Ok(Some(_))),
            "process running from the bundled path must be terminated"
        );
        assert!(
            matches!(bystander.try_wait(), Ok(None)),
            "node from a DIFFERENT path must never be touched"
        );

        let _ = orphan.wait();
        let _ = bystander.kill();
        let _ = bystander.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn image_path_match_is_case_insensitive_but_exact() {
        // QueryFullProcessImageNameW may report different casing than our resolved path;
        // same_path must still match — while a DIFFERENT node install must not.
        assert!(same_path(
            Path::new(r"C:\PROGRAM FILES\StarNet\NODE.EXE"),
            Path::new(r"C:\Program Files\StarNet\node.exe"),
        ));
        assert!(!same_path(
            Path::new(r"C:\Program Files\nodejs\node.exe"),
            Path::new(r"C:\Program Files\StarNet\node.exe"),
        ));
    }
}

#[cfg(test)]
mod lifecycle_probe_tests {
    use super::*;

    // ---- parse_lifecycle_response: the pure decision the close path/tray rely on (M3) ----

    #[test]
    fn parses_valid_200_snapshot_with_reasons() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"armed\":true,\"reasons\":[\"1 routine armed\",\"Telegram connected\"]}";
        let l = parse_lifecycle_response(raw).expect("valid 200 snapshot parses");
        assert!(l.armed);
        assert_eq!(l.reasons, vec!["1 routine armed", "Telegram connected"]);
    }

    #[test]
    fn parses_valid_200_not_armed() {
        let raw = "HTTP/1.1 200 OK\r\n\r\n{\"armed\":false,\"reasons\":[]}";
        let l = parse_lifecycle_response(raw).expect("valid idle snapshot parses");
        assert!(!l.armed);
        assert!(l.reasons.is_empty());
    }

    #[test]
    fn rejects_non_200_status() {
        // A 403 (token mismatch) or 500 must NOT read as a snapshot — the caller classifies it Ambiguous
        // (alive but unwell), never "not armed".
        assert!(parse_lifecycle_response("HTTP/1.1 403 Forbidden\r\n\r\nforbidden token").is_none());
        assert!(parse_lifecycle_response("HTTP/1.1 500 Internal Server Error\r\n\r\n{\"error\":\"x\"}").is_none());
    }

    #[test]
    fn rejects_missing_or_garbage_body() {
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n").is_none(), "empty body");
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\nnot-json").is_none(), "garbage body");
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK").is_none(), "no header/body separator");
        assert!(parse_lifecycle_response("").is_none(), "empty response (read timeout yielded nothing)");
    }

    #[test]
    fn rejects_200_without_armed_field() {
        // `armed` must be present and boolean — defaulting a missing field to false would let a half-written
        // response authorize a kill.
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n{\"reasons\":[]}").is_none());
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n{\"armed\":\"yes\"}").is_none());
    }

    #[test]
    fn tolerates_missing_reasons() {
        let l = parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n{\"armed\":true}").expect("armed without reasons parses");
        assert!(l.armed);
        assert!(l.reasons.is_empty());
    }

    // ---- refused-vs-timeout classification (the M2 distinction) ----

    #[test]
    fn refused_connect_classifies_not_running() {
        // Reserve a port, then close the listener so nothing is listening — connect must be refused.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(matches!(
            probe_lifecycle_armed(port, "t", Duration::from_millis(300)),
            LifecycleProbe::NotRunning
        ));
    }

    #[test]
    fn silent_listener_classifies_ambiguous_not_not_running() {
        // A listener that ACCEPTS but never responds = alive-but-slow sidecar. This must be Ambiguous
        // (fail open), never NotRunning — killing on this evidence could destroy armed work.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            // Hold the accepted socket open (no response) until the client times out.
            if let Ok((sock, _)) = listener.accept() {
                std::thread::sleep(Duration::from_millis(900));
                drop(sock);
            }
        });
        let got = probe_lifecycle_armed(port, "t", Duration::from_millis(300));
        assert!(matches!(got, LifecycleProbe::Ambiguous));
        let _ = handle.join();
    }

    #[test]
    fn live_responder_classifies_armed() {
        use std::io::{Read as _, Write as _};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf); // consume the request head
                let body = "{\"armed\":true,\"reasons\":[\"Night shift armed\"]}";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        match probe_lifecycle_armed(port, "t", Duration::from_millis(1000)) {
            LifecycleProbe::Armed(l) => {
                assert!(l.armed);
                assert_eq!(l.reasons, vec!["Night shift armed"]);
            }
            _ => panic!("a live 200 responder must classify Armed"),
        }
        let _ = handle.join();
    }
}

#[cfg(test)]
mod webview_cache_purge_tests {
    use super::*;

    #[test]
    fn purges_on_first_run_when_marker_missing() {
        assert!(should_purge_webview_cache(None, "0.2.4"));
    }

    #[test]
    fn purges_when_packaged_build_changed() {
        assert!(should_purge_webview_cache(
            Some("0.8.0|exe:old:12"),
            "0.8.0|exe:new:12"
        ));
    }

    #[test]
    fn same_version_legacy_marker_forces_migration_purge() {
        assert!(should_purge_webview_cache(
            Some("0.8.0"),
            "0.8.0|exe:new:12"
        ));
    }

    #[test]
    fn no_purge_when_exact_packaged_build_is_unchanged() {
        assert!(!should_purge_webview_cache(
            Some("0.8.0|exe:same:12"),
            "0.8.0|exe:same:12"
        ));
    }

    #[test]
    fn tolerates_whitespace_in_marker() {
        // Markers are written via fs::write and read back with read_to_string; a trailing
        // newline or stray whitespace must NOT be read as a build change (would purge every
        // boot). trim() on both sides guards that.
        assert!(!should_purge_webview_cache(
            Some("0.8.0|exe:same:12\n"),
            "0.8.0|exe:same:12"
        ));
        assert!(!should_purge_webview_cache(
            Some("  0.8.0|exe:same:12  "),
            "0.8.0|exe:same:12"
        ));
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
