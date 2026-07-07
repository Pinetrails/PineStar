use std::process::Command;

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

fn main() {
    // `--always` falls back to the short hash when there is no tag; `--dirty` appends `-dirty` on an unclean tree.
    let describe = git_output(&["describe", "--always", "--dirty", "--tags"]).unwrap_or_else(|| "unknown".to_string());

    // Split describe into a bare commit + a dirty flag so the frontend can render "DIRTY" distinctly.
    let dirty = describe.ends_with("-dirty");
    let commit = git_output(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=STARNET_BUILD_COMMIT={}", commit);
    println!("cargo:rustc-env=STARNET_BUILD_DESCRIBE={}", describe);
    println!("cargo:rustc-env=STARNET_BUILD_DIRTY={}", if dirty { "1" } else { "0" });

    // Re-run this build script when HEAD moves or the index changes, so the stamp tracks the working tree. These
    // paths may not exist in a source-tarball build (no .git) — that's fine, Cargo just won't watch them.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");

    tauri_build::build();
}
