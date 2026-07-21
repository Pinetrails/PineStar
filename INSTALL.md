# Installing StarNet (Desktop)

StarNet desktop ships for **Windows, macOS, and Linux**. Every platform is built by the same
CI release train and updates through the same signed feed. None of the builds are code-signed
for the operating system yet (no paid Windows Authenticode certificate, no Apple Developer
cert), so each OS will warn you before letting a new app run. This is expected for an early
build — below is exactly what you'll see on each platform and what to do.

> **Honesty note for macOS and Linux users:** these builds are produced by the same CI and are
> cryptographically signed for auto-updates, but they have had **less real-world testing than
> the Windows build** at launch. If something is broken, please tell us:
> **androo.agi@gmail.com**. We'd rather hear about it than have you assume it's supposed to be
> that way.

## Download

Go to the releases page:
<https://github.com/androoAGI/starnet-releases/releases/latest>

Pick the asset for your platform:

| Platform | Download this asset |
| --- | --- |
| **Windows** (10/11, 64-bit) | `StarNet_<version>_x64-setup.exe` |
| **macOS — Apple Silicon** (M1/M2/M3/M4) | `StarNet_<version>_aarch64.dmg` |
| **macOS — Intel** | `StarNet_<version>_x64.dmg` |
| **Linux — Debian/Ubuntu** | `StarNet_<version>_amd64.deb` |
| **Linux — anything else** | `StarNet_<version>_amd64.AppImage` |

Not sure which macOS you have? Apple menu → **About This Mac**. If it says "Apple M…" pick
**Apple Silicon (aarch64)**; if it says "Intel" pick **Intel (x64)**. Installing the wrong one
will not run.

---

## Windows

The installer is currently **unsigned** (no paid Authenticode certificate yet), so Windows
will warn you before letting it run. This is expected for an early build — here is exactly
what you will see and what to do.

### Windows SmartScreen ("Windows protected your PC")

When you run the installer, Windows SmartScreen will likely show a blue box saying
*"Windows protected your PC"* and hide the run button. This appears **because the installer
is unsigned and new**, not because anything is wrong with it.

To proceed:

1. Click **More info**.
2. Click **Run anyway**.

The installer then runs normally.

### Smart App Control (SAC) — honest caveat

Newer Windows 11 machines may have **Smart App Control** turned on. Unlike SmartScreen, SAC
in **enforce mode cannot be bypassed** with "Run anyway" — it will simply block an unsigned
installer with no override. This is a hard block, and there is nothing the installer can do
about it.

If SAC blocks the install, your options are:

- **Check your SAC mode.** Open *Windows Security → App & browser control → Smart App Control
  settings*. If it shows **Evaluation** or **Off**, unsigned installers can still run. If it
  shows **On (enforce)**, unsigned apps are blocked.
- SAC's enforce state is set at OS install time and **cannot be re-enabled once turned off**,
  so we do not recommend changing it just for us. If you are on enforced SAC, you will need to
  wait for a code-signed StarNet build (Authenticode signing is on the roadmap).

We would rather tell you this up front than have the installer mysteriously vanish.

### Uninstalling (Windows)

Uninstall StarNet from **Settings → Apps → Installed apps** like any other Windows app.

---

## macOS

The macOS app is **unsigned and un-notarized** (we don't have an Apple Developer certificate
yet). Because of that, macOS Gatekeeper will refuse to open it on the first try — you'll see
a dialog like *"StarNet cannot be opened because Apple cannot check it for malicious
software"* or *"…is damaged."* Nothing is actually wrong with the file; macOS just won't run
un-notarized apps without an explicit override.

To install:

1. Open the `.dmg` you downloaded (the correct one for your chip — Apple Silicon `aarch64` or
   Intel `x64`) and drag **StarNet** into **Applications**, as the DMG window shows.
2. Try to open StarNet from Applications. macOS will block it the first time.
3. Approve it, using whichever your macOS version supports:
   - **Current macOS (Ventura / Sonoma and newer):** open **System Settings → Privacy &
     Security**, scroll to the **Security** section. After you've tried to open StarNet once,
     a line appears there saying StarNet was blocked — click **Open Anyway**, then confirm in
     the dialog that follows.
   - **Older macOS:** **right-click** (or Control-click) the StarNet app in Applications and
     choose **Open** from the menu, then click **Open** in the dialog. Using the menu's Open
     gives you the override that a normal double-click does not.

You only have to do this once. After the first approved launch, StarNet opens normally.

### Uninstalling (macOS)

Quit StarNet, then drag **StarNet** from **Applications** to the Trash.

---

## Linux

Two formats are provided. Pick one:

### Debian / Ubuntu (`.deb`)

```bash
sudo apt install ./StarNet_<version>_amd64.deb
```

`apt` will pull in the runtime libraries StarNet needs. If you install the `.deb` a different
way and hit a missing-library error, the dependencies StarNet (a Tauri/WebKitGTK app) needs at
runtime are the WebKitGTK stack and friends:

```bash
sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
```

(These mirror the WebKit + tray + SVG libraries the CI build links against.)

### AppImage (any distro)

The AppImage is a single self-contained file — no install step:

```bash
chmod +x StarNet_<version>_amd64.AppImage
./StarNet_<version>_amd64.AppImage
```

If it won't launch, your distro may be missing WebKitGTK. Install `libwebkit2gtk-4.1-0`
(Debian/Ubuntu) or your distro's equivalent WebKit2GTK 4.1 package, plus a working FUSE if the
AppImage complains about mounting.

### Uninstalling (Linux)

- `.deb`: `sudo apt remove starnet`
- AppImage: just delete the file.

---

## Updates (all platforms)

Once installed, StarNet updates itself through its built-in updater (System → Updates). It
checks the public releases channel, verifies each update's cryptographic signature against a
key baked into the app, and installs verified updates in place. You do not need to re-download
from this page for routine updates — on any platform.

This updater signature is **separate** from OS code-signing (Authenticode / Apple notarization
/ Linux packaging). It protects the integrity of updates and is **always active**, on every
platform, regardless of whether the OS considers the app "signed." So even though the macOS and
Windows builds trip their OS's first-run warning, every update they pull afterward is
cryptographically verified before it installs.

## Why unsigned?

OS code-signing certificates (Windows Authenticode, an Apple Developer ID) cost money and take
time to procure and build reputation. These builds are distributed unsigned so early testers
can use them now; signed builds — which remove the SmartScreen wall on Windows, work under
Smart App Control, and open without the Gatekeeper prompt on macOS — are planned. The updater
signature described above is a **separate** mechanism: it protects the integrity of updates and
is always active regardless of OS-signing status.
