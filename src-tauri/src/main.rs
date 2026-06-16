// Skynet — native desktop shell (Tauri v2).
//
// This is the thin wrap (roadmap step 2.0). It does NOT reimplement the app: it
// boots the existing zero-dependency Node sidecar on a private loopback port,
// waits for it to start listening, then opens that URL in a native WebView2
// window. The sidecar's lifetime is bound to this process — it is killed on exit
// so closing the window never strands an agent host. The browser frontend and the
// agent runtime are unchanged; this crate only owns the window and the child.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Owns the spawned sidecar process so we can tear it down deterministically.
struct Sidecar(Mutex<Option<Child>>);

impl Sidecar {
    fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Reserve an unused TCP port on the loopback interface, then release it so the
/// sidecar can bind it a moment later.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .expect("could not reserve a local port for the sidecar")
}

/// Locate the directory holding `sidecar/index.js` (with `frontend/` and
/// `shared/` beside it). In dev we run against the live worktree (one level
/// above this crate); a packaged build reads them from the bundled resource dir.
fn project_root(app: &tauri::AppHandle) -> PathBuf {
    let raw = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        app.path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
    };
    strip_verbatim(&raw)
}

/// Node.js can't use a Windows `\\?\` verbatim path as its main module or cwd —
/// it tries to `lstat` the bare drive letter and fails with EISDIR. Normalize it
/// back to a plain `C:\...` path before handing it to node.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// Spawn `node sidecar/index.js` bound to `port`, with no flashing console window.
fn spawn_sidecar(root: &PathBuf, port: u16) -> std::io::Result<Child> {
    let entry = root.join("sidecar").join("index.js");
    let mut cmd = Command::new("node");
    cmd.arg(&entry)
        .env("SKYNET_PORT", port.to_string())
        .current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
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

fn main() {
    tauri::Builder::default()
        // A second launch should focus the running window, not spin up a 2nd sidecar.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            let root = project_root(app.handle());
            let port = free_port();

            // Boot the sidecar; the window loads it once it's listening, otherwise
            // it falls back to a local diagnostic page.
            let url: WebviewUrl = match spawn_sidecar(&root, port) {
                Ok(child) => {
                    app.manage(Sidecar(Mutex::new(Some(child))));
                    if wait_for_port(port, Duration::from_secs(25)) {
                        WebviewUrl::External(
                            format!("http://127.0.0.1:{port}/")
                                .parse()
                                .expect("valid sidecar url"),
                        )
                    } else {
                        eprintln!("[skynet] sidecar did not start listening on port {port}");
                        WebviewUrl::App("index.html".into())
                    }
                }
                Err(e) => {
                    eprintln!("[skynet] failed to spawn node sidecar: {e}");
                    app.manage(Sidecar(Mutex::new(None)));
                    WebviewUrl::App("index.html".into())
                }
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
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    sidecar.kill();
                }
            }
        });
}
