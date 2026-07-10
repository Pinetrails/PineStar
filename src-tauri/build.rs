use std::{path::Path, process::Command};

// Cargo only re-runs a build script when one of its declared inputs changes. Git's HEAD/index
// cover commits and staged edits, but not an unstaged edit to a file that Tauri embeds. Keep this
// list aligned with tauri.conf.json plus the desktop crate inputs so cached provenance can never
// survive a change to bytes that may ship in the app.
const SHIPPED_INPUTS: &[&str] = &[
    "../frontend",
    "../sidecar",
    "../shared",
    "src",
    "capabilities",
    "icons",
    "installer",
    "binaries",
    "build.rs",
    "Cargo.toml",
    "Cargo.lock",
    "tauri.conf.json",
];

// git describe --dirty intentionally ignores untracked files. These are the repository-relative
// roots whose Git-owned contents are packaged; include untracked additions when deciding whether
// the source identity is dirty. Gitignored generated inputs (notably binaries/) remain governed by
// the artifact hash rather than making every normal release build dirty.
const SHIPPED_GIT_ROOTS: &[&str] = &["frontend", "sidecar", "shared", "src-tauri"];

/// P1.5 (UPDATE_STATE_SAFETY_AUDIT): embed the git commit + dirty state at COMPILE TIME so every binary can say
/// exactly which source it was built from. `git describe --always --dirty` yields e.g. `c160d905` (clean) or
/// `c160d905-dirty` (uncommitted working tree — the exact hazard the audit flagged: locally-built installers with
/// bumped-then-reverted versions and no tag). Git missing / not a repo → "unknown" (never fail the build).
///
/// The values are exposed to the Rust code as compile-time env via `env!("STARNET_BUILD_COMMIT")` etc. They land in
/// the binary's read-only string data (survives `strip = true`, which only drops debug symbols) so the release
/// train can grep the built exe for the expected commit.
fn git_output(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn shipped_inputs_dirty() -> Option<bool> {
    let mut cmd = Command::new("git");
    cmd.args([
        "-C",
        "..",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--",
    ]);
    cmd.args(SHIPPED_GIT_ROOTS);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(!out.stdout.is_empty())
}

fn emit_git_rerun_path(name: &str) {
    if let Some(path) = git_output(&["rev-parse", "--git-path", name]) {
        if Path::new(&path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

fn emit_rerun_inputs() {
    for path in SHIPPED_INPUTS {
        println!("cargo:rerun-if-changed={path}");
    }

    // Resolve Git's real files instead of assuming ../.git is a directory. In a worktree it is a
    // text file, while HEAD/index and the branch ref live under the integration tree's .git area.
    for name in ["HEAD", "index", "packed-refs"] {
        emit_git_rerun_path(name);
    }
    if let Some(head_ref) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        emit_git_rerun_path(&head_ref);
    }
}

fn main() {
    emit_rerun_inputs();

    // `--always` falls back to the short hash when there is no tag; `--dirty` appends `-dirty` on an unclean tree.
    let mut describe = git_output(&["describe", "--always", "--dirty", "--tags"])
        .unwrap_or_else(|| "unknown".to_string());

    // `git describe --dirty` covers tracked staged/unstaged edits. The status check adds untracked
    // shipped inputs, which can also alter the packaged app but are otherwise invisible to describe.
    let describe_dirty = describe.ends_with("-dirty");
    let dirty = describe_dirty || shipped_inputs_dirty().unwrap_or(false);
    if dirty && !describe_dirty && describe != "unknown" {
        describe.push_str("-dirty");
    }
    let commit =
        git_output(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    // The short value remains the human-facing diagnostic label. The full SHA is a separate release-proof
    // identity: prefix matching is not strong enough to bind an installed artifact to one immutable candidate.
    let full_sha = git_output(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=STARNET_BUILD_COMMIT={}", commit);
    println!("cargo:rustc-env=STARNET_BUILD_SHA={}", full_sha);
    println!("cargo:rustc-env=STARNET_BUILD_DESCRIBE={}", describe);
    println!(
        "cargo:rustc-env=STARNET_BUILD_DIRTY={}",
        if dirty { "1" } else { "0" }
    );

    tauri_build::build();
}
