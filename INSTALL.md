# Installing StarNet (Desktop)

StarNet desktop ships for **Windows and macOS**. Both platforms are built by the same
CI release train and update through the same signed feed. None of the builds are code-signed
for the operating system yet (no paid Windows Authenticode certificate, no Apple Developer
cert), so each OS will warn you before letting a new app run. This is expected for an early
build — below is exactly what you'll see on each platform and what to do.

> **Honesty note for macOS users:** the macOS build is produced by the same CI and is
> cryptographically signed for updates, but it has had **less real-world testing than
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
| **macOS** — all Macs, including Apple Silicon (M1/M2/M3/M4) | `StarNet_<version>_x64.dmg` |

> **Apple Silicon Macs: download the `x64` DMG too.** Until StarNet is Apple-notarized, opening
> the native `aarch64` build on Apple Silicon fails with a false *"StarNet is damaged and
> can't be opened"* error that offers no override — nothing is actually wrong with the file,
> but macOS gives you no way past that dialog. The `x64` build is the one that runs on every
> Mac (Apple Silicon runs it through Rosetta 2, with only the one-time "Open Anyway" approval
> described below). The `aarch64.dmg` on the releases page will become the recommended Apple
> Silicon download once notarization ships.

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

1. Open the `x64` `.dmg` you downloaded (yes, on Apple Silicon too — see the note in the
   Download section) and drag **StarNet** into **Applications**, as the DMG window shows.
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

## Updates

Once installed, StarNet on **Windows** updates itself through its built-in updater (System →
Updates). It checks the public releases channel, verifies each update's cryptographic
signature against a key baked into the app, and installs verified updates in place.

On **macOS**, automatic updates aren't wired up yet — when a new version ships, download the
newest `.dmg` from the releases page and replace the app in Applications. Automatic macOS
updates arrive together with the notarized build.

This updater signature is **separate** from OS code-signing (Authenticode / Apple
notarization). It protects the integrity of updates and is **always active**, regardless of
whether the OS considers the app "signed." So even though the builds trip their OS's first-run
warning, every update pulled afterward is cryptographically verified before it installs.

## Why unsigned?

OS code-signing certificates (Windows Authenticode, an Apple Developer ID) cost money and take
time to procure and build reputation. These builds are distributed unsigned so early testers
can use them now; signed builds — which remove the SmartScreen wall on Windows, work under
Smart App Control, and open without the Gatekeeper prompt on macOS — are planned. The updater
signature described above is a **separate** mechanism: it protects the integrity of updates and
is always active regardless of OS-signing status.
