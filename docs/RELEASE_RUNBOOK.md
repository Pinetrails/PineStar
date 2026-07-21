# StarNet release runbook

Solo, 2am, tired: follow this top to bottom. Every step is a command to paste or an exact
click. Nothing here says "ensure that" — if a step is judgment, it tells you the exact thing
to look at and the exact decision.

**Read these two first (they are the design this runbook executes):**
- `docs/UPDATE_PIPELINE_AUDIT_2026-07-06.md` — why the pipeline is shaped this way (the P0/P1
  weaknesses this train fixes).
- `docs/RELEASE_TRAIN_BUILD_PLAN_2026-07-06.md` — the pinned contracts (C1–C5) each script and
  workflow was built to.

**The one law of this pipeline:** nothing reaches a user until *you* click **Publish** on
GitHub. The release train only ever stages a **DRAFT**. Until you publish, zero clients can
see or download anything.

**Fixed facts (from the code, do not retype from memory):**
- Public source repo: `nonfungiblefunyuns-ship-it/starnet` — where you run
  `release:bump` and where the train workflow lives.
- Public releases repo: `nonfungiblefunyuns-ship-it/starnet-releases` — installers live here,
  and this is what the updater points at.
- Updater endpoint baked into every shipped binary
  (`src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]`):
  `https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/latest/download/latest.json`
- Updater signing key: `~/.tauri/starnet-updater.key` (see section 4 — this is the single
  most dangerous thing to lose in the whole project).
- Last version *built* at time of writing: `0.4.1` (`tauri.conf.json`). **Nothing has ever been
  published** — `starnet-releases` carries no public release, so `releases/latest` currently 404s
  and `v1.0.0` will be the first real public artifact. (The `0.1.9` / `0.2.0` version numbers used
  as examples below are illustrative, not a shipped history.)

---

## 0. READY GATE (do this BEFORE you bump anything)

Before `release:bump`, before the tag, before you touch a version number:

```
npm run qa:ready
```

Read the last line. There are exactly two outcomes:

- **READY** → proceed to section 1. The house is green: zero open P0/P1 findings, the Guardian's last
  cycle is green and fresh, `qa:journeys` passes, the Beginner Run isn't stuck, and the installed-exe
  smoke stamp (`qa/installed/last-smoke.json`) is fresh + GREEN. You're clear to cut.
- **NOT READY** → **stop. Do not bump. Do not tag.** Every NOT-READY line names the check that failed.
  Route those findings (`node scripts/qa/ledger.mjs --digest`), fix them on trunk, and re-run
  `npm run qa:ready` until it prints READY. No version is cut against a red house — that's the whole
  point of the gate (READY-GATE law, `docs/RELEASE_READINESS.md`).

No-fake-green: if `qa:ready` itself can't run (missing script, a check that errors), that is a NOT
READY — treat it as red, not as permission to proceed. And if you're cutting the real release off an RC
you soaked, the READY receipt you earned at soak end (`docs/RELEASE_READINESS.md` §2.3) is exactly this
gate — re-run it here to confirm it's still green at cut time.

---

## 1. NORMAL CUT

You are cutting version `<VER>` (example below uses `0.2.0`). Do these in order.

### 1.1 Bump the version (creates the commit + tag locally, pushes nothing)

```
npm run release:bump 0.2.0
```

This (per contract C1) bumps `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`
(+ refreshes `Cargo.lock`), scaffolds `RELEASE_NOTES.md`, commits `release: v0.2.0` with those
files only, and creates the tag `v0.2.0`. It does **not** push.

> Want to see exactly what it will touch first? `npm run release:bump 0.2.0 -- --dry-run`

### 1.2 Write the real release notes

`release:bump` scaffolds `RELEASE_NOTES.md` with a `# StarNet v0.2.0` header and a TODO
bullet. Open it and replace the TODO with the actual user-facing changes — these notes become
the GitHub release body AND the text a user sees in the in-app UPDATE CENTER. Then amend them
into the release commit so the tag points at the final notes:

```
git add RELEASE_NOTES.md
git commit --amend --no-edit
git tag -f v0.2.0
```

### 1.3 Review the commit before it leaves your machine

```
git show --stat v0.2.0
```

Eyeball: version is `0.2.0` in **both** `tauri.conf.json` and `Cargo.toml`; `RELEASE_NOTES.md`
reads the way you want; no stray files snuck into the commit.

### 1.4 Run the gate locally AFTER the bump, BEFORE pushing the tag

```
npm run test:fast
```

The bump changes the shipped version, and any test coupled to it will fail the train's CI
gate AFTER the tag is pushed — which burns a version number (tags are never force-moved;
a failed tag means cutting a patch). This exact mistake cost v0.2.0 AND v0.2.1 on
2026-07-06 (a fixture pinned near the current version). Green locally post-bump = the CI
gate will be green too.

### 1.5 Push the tag — this is what starts the train

```
git push origin v0.2.0
```

Pushing the `v*` tag triggers `.github/workflows/release-train.yml`.
(You do not need to push the branch for the train; the tag is the trigger. Push the branch too
if you want the commit on the branch: `git push origin HEAD`.)

### 1.6 Watch the train (4 jobs)

Open the source repo → **Actions** → the **release-train** run for tag `v0.2.0`. Per contract
C4 it runs four jobs in sequence; each must go green before the next starts:

1. **gate** (ubuntu) — `npm ci` + `npm run test:fast`. Red here = the code is broken; nothing
   builds. Fix the code, cut a new patch tag. Do not proceed.
2. **build** (matrix: windows nsis / ubuntu-22.04 deb+appimage / macOS arm64 dmg / macOS x64
   dmg) — updater signing is **required** here; a leg fails if it did not produce its updater
   artifact + `.sig`. All four legs must be green.
3. **assemble** (ubuntu) — downloads every leg's artifacts, runs
   `release-assemble-manifest.mjs` to build ONE multi-platform `latest.json`, then runs
   `verify-update-host.mjs --manifest release/latest.json` against that local manifest.
4. **stage-draft** — creates (or re-syncs) a **DRAFT** release `v0.2.0` on
   `starnet-releases` with all installers + `.sig` files + `latest.json` attached, and prints a
   go/no-go summary ending in "DRAFT staged — nothing is live until you click Publish."

If any job is red, go to **section 2**.

### 1.7 Review the DRAFT release

Open: `https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases` → the draft
tagged **v0.2.0** (it has a grey "Draft" badge; it is NOT yet the public "latest").

Checklist — eyeball all of these before you publish:
- **Version / tag** is exactly `v0.2.0` (leading `v`, matches what you bumped).
- **Notes** are your real `RELEASE_NOTES.md` text, not the TODO scaffold.
- **Assets count.** You should see, at minimum:
  - `latest.json` (exactly one)
  - Windows: `StarNet_0.2.0_x64-setup.exe` + its `.sig`
  - macOS Apple Silicon: an `.app.tar.gz` (aarch64) + its `.sig`, and the `.dmg`
  - macOS Intel: an `.app.tar.gz` (x64) + its `.sig`, and the `.dmg`
  - Linux: the `.AppImage` + its `.sig` (and the `.deb`)
  - Rule of thumb: **every updater artifact has a matching `.sig`** and **there is exactly one
    `latest.json`**. A `.sig` with no artifact, or an artifact with no `.sig`, is a red flag —
    do not publish; re-run **stage-draft** (section 2.2).

### 1.8 Publish (the only human ship gate)

On the draft release page: **Edit** (pencil) if needed → scroll to the bottom → make sure
**"Set as the latest release"** is checked and **"Set as a pre-release"** is **un**checked →
click **Publish release**.

The moment you publish, GitHub repoints `releases/latest` at v0.2.0, and every client's
6-hour check loop will start pulling the new `latest.json`.

### 1.9 Prove the live endpoint is coherent

```
npm run release:verify-host
```

This fetches the LIVE endpoint (from `tauri.conf.json`) and checks, for every platform in the
manifest: schema, signature shape, version ≥ shipped, and asset URL reachability. Expect
**ALL CHECKS PASSED**. If it fails, go to **section 2.4**.

Pin the expected version to catch a stale "latest":
```
npm run release:verify-host -- --expect-version 0.2.0
```

### 1.10 Canary proof (an actually-installed older StarNet takes the update)

`verify-host` proves the *feed* is correct; the canary proves the *client* consumes it. Do
this on a machine (or VM) that already has an **older** StarNet installed (e.g. 0.1.9):

1. Launch that older installed StarNet (the packaged desktop app, not a browser/dev build).
2. Open **Settings** → **UPDATES** section → click **UPDATE CENTER**.
3. In the UPDATE CENTER, click **CHECK NOW**.
4. Confirm the card shows **AVAILABLE v0.2.0** with your release notes.
5. Click **INSTALL UPDATE**. Watch the progress bar go downloading → installing → restarting.
   (The signature is verified by Tauri against the baked-in pubkey during install; a bad/mis-
   signed artifact fails here instead of installing.)
6. After it relaunches, open UPDATE CENTER again — the header should read **current v0.2.0** and
   "No update is pending."

That is a done release: feed green + a real old client pulled, verified, installed, and
relaunched onto the new version.

---

## 2. PARTIAL-FAILURE RECOVERY

The train is designed so you almost never have to re-cut from scratch. Match your symptom.

### 2.1 One matrix leg is red (e.g. macOS x64 failed, others green)

- Open the failed **build** run → **Re-run jobs** → **Re-run failed jobs**. Transient runner
  flakes (network, cache, the E0463 ctor race) usually clear on a re-run.
- If the same leg fails twice with a real compile/sign error, that platform genuinely can't
  build this commit. **Do not publish a draft that is missing a platform** — every user on the
  missing OS would be stranded. Fix the cause, then cut a patch (`npm run release:bump 0.2.1`).
- If a leg failed only because the updater `.sig` was missing, the signing secret is empty on
  the source repo — see **section 4** to set `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, then re-run.

### 2.2 Draft is half-uploaded (some assets attached, some missing)

The **stage-draft** job uploads assets with `--clobber`, so it is **idempotent** — re-running
it re-uploads/overwrites without erroring on the assets already there.

- Actions → the release-train run → **Re-run jobs** → re-run **stage-draft** (re-running
  `assemble` too is fine and cheap if the manifest itself looked wrong).
- Then re-check the draft's asset list per **section 1.6**.
- Do NOT hand-delete individual assets on the draft first; `--clobber` handles overwrites.

### 2.3 "Tag already exists" when re-running

The tag `v0.2.0` already exists on the source repo (you pushed it) and possibly a draft
release exists on `starnet-releases`. Decide by whether the *artifacts* are wrong:

- **Artifacts are fine, only the draft is messy/half-uploaded** → keep the tag. Just re-run
  **stage-draft** (2.2). `gh release create` in the train is written to reuse an existing draft
  and `--clobber` its assets, so a re-run repairs it in place.
- **You need to actually rebuild** (bad commit, wrong notes baked into the tag, wrong version)
  → do NOT reuse the tag. **Bump a fresh patch version** — it is always safer than force-moving
  a tag that CI has already built from:
  ```
  npm run release:bump 0.2.1
  ```
  If a broken **draft** for the old version is lying around on `starnet-releases`, delete it
  first (drafts are invisible to users, so this is harmless):
  `Releases → the v0.2.0 draft → Delete`.
- Only force-move a tag (`git tag -f` + `git push -f origin v0.2.0`) if **nothing** has been
  published or drafted from it yet and you are certain no CI artifacts depend on it. When in
  doubt, bump the patch instead.

### 2.4 `release:verify-host` is red AFTER you published

The script prints a "Common causes" list on failure (copied verbatim from
`verify-update-host.mjs`'s `finish()` so you don't have to open the file):

```
The updater path is NOT yet live/coherent. Common causes:
  - release not published yet (draft releases do not resolve latest/download)
  - tag is not exactly v<version>, so the pinned installer URL 404s
  - latest.json / installer / .sig not all attached to the release
```

Translated to action:
- **"release not published yet"** — you're still looking at a draft. Publish it (1.7). `latest`
  only resolves for a *published, non-prerelease* release.
- **"tag is not exactly v<version>"** — the release tag isn't `v0.2.0`, so the installer URL
  inside `latest.json` (pinned to `/download/v0.2.0/…`) 404s. The tag on the release must be
  exactly `v` + the version. Re-tag the release correctly or cut a patch with the right tag.
- **"latest.json / installer / .sig not all attached"** — an asset is missing from the
  published release. Re-run **stage-draft** to re-attach (2.2). If you already published, you
  can attach the missing asset directly to the published release, then re-run verify.
- **"installer asset reachable" fails** — the `latest.json` URL is right but the asset behind
  it 404s (asset name mismatch, or attached to the wrong release). Confirm the asset filename on
  the release matches the `url` inside `latest.json`.

---

## 3. EMERGENCY ROLLBACK

A bad version is live and users are pulling it. You have two independent populations:

### 3.1 Users who have NOT updated yet — roll back the feed

Delete the bad release on `starnet-releases`:
`Releases → v0.2.0 (the bad one) → Delete release`.

GitHub immediately repoints `releases/latest` at the **previous** published release (e.g.
0.1.9), which carries **its own** `latest.json`. Within minutes, every client that hasn't
updated yet will see the older manifest again and stop pulling the bad one. No manifest edit is
needed — the pointer follows the newest published release automatically.

> If you'd rather not lose the release entirely: edit it and check **"Set as a pre-release"**.
> GitHub never points `latest` at a prerelease, so this also takes it out of the feed while
> keeping the assets. Deleting is the cleaner, more obvious 2am move.

### 3.2 Users who ALREADY updated to the bad version — FIX FORWARD ONLY

Tauri's updater **never offers a lower version** — it will not downgrade. Anyone already on the
bad build cannot be rolled back; they can only be moved *forward* to a fixed build. So:

```
npm run release:bump 0.2.1
```
Fix the bug in that patch, run the full train (section 1), and publish it. Already-updated
users get 0.2.1 on their next check; not-yet-updated users were already protected by 3.1.

### 3.3 Comms template (paste into your channel / release notes)

```
StarNet 0.2.0 had a problem and has been pulled. If you're still on an earlier
version you'll stay there — nothing to do. If you already updated to 0.2.0, a fix
(0.2.1) is on the way; your app will offer it automatically within a few hours, or
open Settings → UPDATES → UPDATE CENTER → CHECK NOW to grab it immediately.
Sorry for the noise.
```

---

## 4. KEY MANAGEMENT (read this before you ever need it)

`~/.tauri/starnet-updater.key` is the updater signing key. Its **public** half is baked into
**every StarNet binary ever shipped** (`tauri.conf.json` → `plugins.updater.pubkey`). The
endpoint is fixed and the pubkey in installed apps can't be changed remotely. Therefore:

> **If you lose this key, no installed StarNet can ever update again — on any machine, forever.**
> There is no re-signing path for already-shipped binaries. This is the single highest-
> consequence item in the whole project. Back it up before you do anything else tonight.

### 4.1 Back it up NOW — ≥2 offline copies

The key is a small text file. Copy it to at least two places that are **not** this machine and
**not** a synced cloud folder you could accidentally wipe:

```
# see it exists
ls -l ~/.tauri/starnet-updater.key

# copy to two removable/offline destinations (adjust drive letters)
cp ~/.tauri/starnet-updater.key /d/backups/starnet-updater.key      # e.g. a USB stick
cp ~/.tauri/starnet-updater.key /e/backups/starnet-updater.key      # e.g. a second stick / drive
```

Also record the key's password. It is **empty** (that's deliberate — see the header of
`scripts/release-cut.mjs`), so the note is literally "password: (empty string)". Store that
note with the backups so a future you doesn't assume it's lost.
Treat these copies like a house key: offline, physically controlled, never committed to git and
never pasted into chat.

### 4.2 Refresh the GitHub secrets (source repo)

The train signs on CI, so the key also lives as two Actions secrets on the **source** repo
(Settings → Secrets and variables → Actions):
- `TAURI_SIGNING_PRIVATE_KEY` — the **entire contents** of `~/.tauri/starnet-updater.key`
  (the whole file, not a path).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — an **empty** string.

To refresh (e.g. new machine, or you rotated): open each secret → Update → paste the file
contents / leave the password empty → Save. The publish token
`RELEASES_TOKEN` (fine-grained PAT with Contents:write on `starnet-releases`) also lives here;
refresh it the same way if it expires.

### 4.3 Rotation plan (only if the key is compromised — it is a big deal)

You cannot just swap keys: installed apps trust the OLD pubkey, so a release signed with a NEW
key would be **rejected** by every existing install and they'd be stuck. Rotation must be a
two-step bridge:

1. **Interim release, signed with the OLD key**, whose `tauri.conf.json` carries the **NEW**
   pubkey. Existing installs accept it (old signature) and, once installed, now trust the new
   pubkey.
2. **All subsequent releases signed with the NEW key.** Clients that took the interim release
   accept them; clients that skipped it are stuck on old-key trust and must be walked to the
   interim build manually.

Because step 2 strands anyone who missed the interim release, keep the interim build available
for a long time and announce it loudly. Rotate only if you truly must (key leak). Otherwise the
right answer is: **don't lose the key** (4.1).

---

## 5. STANDING RULES (violate these and you break the feed for real users)

1. **Only the release train attaches `latest.json`.** `latest.json` is the updater feed. The
   train is the *only* thing that should ever put a `latest.json` on `starnet-releases`. Never
   hand-upload one.
2. **Anything else published on `starnet-releases` must be a PRE-release.** GitHub never points
   `releases/latest` at a prerelease, so test/beta builds (e.g. `desktop-build.yml`'s
   `publish-test`) can't disturb the live feed. If you publish a *non*-prerelease without a
   `latest.json`, the endpoint 404s and every client's check errors until you fix it.
3. **The robocopy in-place hot-patch is DEV-ONLY.** It's a developer convenience for patching a
   local install; it is **never** a user-facing update path. Users update only through the
   signed updater feed.
4. **Verify green on all five platform keys before you Publish.** The draft must have
   windows-x86_64, darwin-aarch64, darwin-x86_64, linux-x86_64, and linux-x86_64-deb (the key
   .deb installs resolve — without it every .deb user downloads the AppImage and fails at
   install) all present and signed, and `verify-update-host` (run against the manifest) must
   pass for all of them. A missing platform strands every user on that OS.
5. **`release.yml` is emergency-fallback only.** It's the old Windows-only, publish-immediately
   path (carries a deprecation header). Do **not** run it with `publish=true` unless the release
   train itself is broken and you must ship. The normal path is always the train.

---

### VERIFICATION STATUS (updated 2026-07-09)

The build tooling this runbook drives has since **merged to trunk** (`feat/harness-backend`) — it was
being built by parallel lanes when the runbook was first written:

- **`npm run release:bump`** (`scripts/release-bump.mjs`), **`scripts/release-assemble-manifest.mjs`**,
  and the 4-job **`.github/workflows/release-train.yml`** (gate → build → assemble → stage-draft) all
  exist on trunk now. Sections 1–2 describe real scripts/jobs, not pending ones.
- **`verify-update-host.mjs`** now supports `--manifest <file>`, `--expect-version X.Y.Z`,
  `--require-platforms <list>`, and `--check-urls`, and validates the full platform set — not
  `windows-x86_64` alone (`npm run release:verify-host` is wired in `package.json`).

**Still unverified — do not trust these until proven:**

- **The release train has never completed a fully-green end-to-end run, and nothing has ever been
  published.** The last version *built* is `0.4.1`; `starnet-releases` has no public release, so
  `releases/latest` currently 404s. Sections 1–2 are written to the workflow as it stands, but the
  tag-push → gate → build → assemble → stage-draft path has not been proven green on live CI (a prior
  cut stalled at the P1.5 build-provenance stamp). Treat the first real cut as the shakedown run.
- **The exact top-level click to reach Settings** in the packaged app was not pinned from code;
  the verified path *inside* Settings is `UPDATES` section → `UPDATE CENTER` button → then
  `CHECK NOW` / `INSTALL UPDATE` (`frontend/app/updates.js`). Confirm the Settings entry point
  on the live desktop build during the canary.

## Local update canary — offline end-to-end proof (no public exposure)

`npm run release:canary` (`scripts/update-canary.mjs`) proves the FULL update cycle on one
Windows machine with nothing published anywhere: check loop → manifest fetch → version
compare → download → minisign verification against the baked pubkey → NSIS passive install →
restart as the new version. The manifest comes from the REAL `release-assemble-manifest.mjs`
(crypto verification included) with only the asset base swapped to `127.0.0.1`.

Canary builds are `StarNet Canary` / `ai.skynet.harness.canary` — side-by-side install,
separate `%APPDATA%` workspace; your real StarNet install and data are untouched. Uninstall
"StarNet Canary" from Windows afterwards.

```powershell
node scripts/update-canary.mjs build-old   # installer @ current version, endpoint = localhost
node scripts/update-canary.mjs build-new   # installer @ patch+1 + signed feed (latest.json)
node scripts/update-canary.mjs serve       # leave running; logs every request the app makes
# install .canary\old\*.exe → open StarNet Canary → Settings → UPDATES → UPDATE CENTER →
# CHECK NOW → INSTALL UPDATE → app restarts as the bumped version. The serve log is the receipt.
```

Each build is a full Rust release build (10–30 min; rustc ctor-race crash = re-run, the cache
resumes). Requires `~/.tauri/starnet-updater.key` (same key as production — deliberately).
This canary does NOT replace the public-path proof (older install → published release →
restart); it de-risks everything except the literal production URL before anything goes public.
