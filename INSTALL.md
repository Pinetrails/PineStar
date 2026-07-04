# Installing StarNet (Desktop)

StarNet desktop is **Windows-only** for now. macOS and Linux builds are not shipped yet.

The installer is currently **unsigned** (no paid Authenticode certificate yet), so Windows
will warn you before letting it run. This is expected for an early build — here is exactly
what you will see and what to do.

## Download

1. Go to the releases page: <https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/latest>
2. Download the installer asset named `StarNet_<version>_x64-setup.exe`.

## Running the unsigned installer

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

## Updates

Once installed, StarNet updates itself through its built-in updater (System → Updates). It
checks the public releases channel, verifies each update's cryptographic signature against a
key baked into the app, and installs verified updates in place. You do not need to
re-download from this page for routine updates.

## Uninstalling

Uninstall StarNet from **Settings → Apps → Installed apps** like any other Windows app.

## Why unsigned?

Authenticode code-signing certificates cost money and take time to procure and build
reputation. This build is distributed unsigned so early testers can use it now; a signed
build (which removes the SmartScreen wall and works under Smart App Control) is planned. The
updater signature described above is a **separate** mechanism — it protects the integrity of
updates and is always active regardless of Authenticode status.
