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
| **macOS — Apple Silicon** (M1/M2/M3/M4) | `StarNet_<version>_aarch64.dmg` |
| **macOS — Intel** | `StarNet_<version>_x64.dmg` |

> **Apple Silicon Macs: use the native `aarch64` DMG.** Because StarNet isn't Apple-notarized
> yet, macOS shows a false *"StarNet is damaged and can't be opened"* dialog on first launch of
> the native build — nothing is actually wrong with the file, and one Terminal command (in the
> macOS section below) clears it permanently. Don't fall back to the `x64` DMG on Apple
> Silicon: it runs under Rosetta 2 translation, and macOS now warns that Intel-only apps
> *"will stop working with a future version of macOS"* — the native build has no such
> deprecation hanging over it.

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
yet). Because of that, macOS Gatekeeper will refuse to open it on the first try. Nothing is
actually wrong with the file; macOS just won't run un-notarized apps without an explicit
override. What you see — and the override — differs by chip, so follow the matching section.

### Apple Silicon (M1/M2/M3/M4) — `aarch64` DMG

On Apple Silicon, the un-notarized native build triggers a false *"StarNet is damaged and
can't be opened. You should move it to the Trash."* dialog — and unlike the Intel warning,
this one offers **no Open Anyway button**. The app is not damaged; the dialog is just how
Gatekeeper phrases "un-notarized arm64 app downloaded from the internet". The fix is to
remove the download quarantine flag once:

1. Open the `aarch64` `.dmg` and drag **StarNet** into **Applications**, as the DMG window
   shows.
2. Open **Terminal** (Cmd-Space, type "Terminal", Enter) and run:

   ```
   xattr -dr com.apple.quarantine /Applications/StarNet.app
   ```

3. Open StarNet from Applications normally.

You only have to do this once per install. (If you update by downloading a new DMG later,
you'll need to run it again for the new copy — this goes away entirely once StarNet is
Apple-notarized.)

### Intel Macs — `x64` DMG

1. Open the `x64` `.dmg` and drag **StarNet** into **Applications**.
2. Try to open StarNet from Applications. macOS will block it the first time with *"StarNet
   cannot be opened because Apple cannot check it for malicious software."*
3. Approve it, using whichever your macOS version supports:
   - **Current macOS (Ventura / Sonoma and newer):** open **System Settings → Privacy &
     Security**, scroll to the **Security** section. After you've tried to open StarNet once,
     a line appears there saying StarNet was blocked — click **Open Anyway**, then confirm in
     the dialog that follows.
   - **Older macOS:** **right-click** (or Control-click) the StarNet app in Applications and
     choose **Open** from the menu, then click **Open** in the dialog. Using the menu's Open
     gives you the override that a normal double-click does not.

You only have to do this once. After the first approved launch, StarNet opens normally.

> If you're on Apple Silicon and previously installed the `x64` build (macOS nags that it
> *"will stop working with a future version of macOS"*): quit StarNet, delete it from
> Applications, and install the `aarch64` DMG using the Apple Silicon steps above. Your data
> is stored outside the app bundle, so nothing is lost by swapping the app.

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
