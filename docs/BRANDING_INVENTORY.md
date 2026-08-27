# Pine Star branding and replacement inventory

This inventory separates presentation identity from StarNet compatibility and records assets that must not ship as Pine Star artwork. It is planning evidence, not an instruction to delete or replace anything in place.

| Path | Current purpose | Runtime use now | Replace/remove before Pine Star distribution | Future replacement |
| --- | --- | --- | --- | --- |
| `frontend/assets/brand/starnet-logo.png` | Former splash/logo art | No primary-shell dependency after PS-2026-002 | Yes | Original Pine Star splash mark |
| `frontend/assets/brand/starnet-logo-small.png` | Retained compact StarNet mark | No current primary-brand reference found | Yes | Original compact Pine Star mark |
| `frontend/assets/brand/starnet-wordmark.svg` | Former topbar mask wordmark | No primary-shell dependency after PS-2026-002 | Yes | Original Pine Star vector wordmark |
| `.github/media/starnet-logo-glow.png` | README/repository logo | README presentation | Yes | Original Pine Star README mark |
| `.github/media/station-iso.png` | README station image | README presentation | Yes | Pine Star product screenshot/art |
| `.github/media/og-card.png` | Repository/social preview card | Metadata/presentation | Yes | Pine Star social card |
| `website/assets/starnet-logo-glow.png` | Public website hero image | Independent website runtime | Yes | Original Pine Star website mark |
| `website/assets/station-iso.png` | Public website station image | Independent website runtime | Yes | Pine Star product image |
| `website/assets/og-card.png` | OpenGraph/Twitter image | Independent website metadata | Yes | Pine Star social card |
| `website/assets/favicon.svg` | Public-site favicon | Independent website runtime | Review and replace | Original Pine Star favicon |
| `src-tauri/icons/**` | Native app/taskbar/platform icons | Native bundle runtime | Yes | Original Pine Star icon family |
| `src-tauri/installer/header.bmp` | NSIS installer header | Installer runtime | Yes | Pine Star installer header |
| `src-tauri/installer/sidebar.bmp` | NSIS installer sidebar | Installer runtime | Yes | Pine Star installer sidebar |
| `src-tauri/installer/dmg-background.png` | macOS installer background | Installer runtime | Yes | Pine Star DMG background |
| `frontend/assets/sprites/**` | Agent characters and animations | Live world runtime | Yes unless separately relicensed | Original Pine Star character roster |
| `frontend/assets/furniture/**` | Station furniture/props | Live world runtime | Yes unless separately relicensed | Original Pine Star tiles and props |
| `website/app/assets/**` | Generated frontend/demo asset mirror | Generated demo runtime | Follows frontend replacement | Generated Pine Star assets |

The sprite and station-art trees include recognizable commercial or public-person character sets and are excluded from StarNet's code license by the upstream README. They remain available as upstream/reference material only. No asset cleanup is part of PS-2026-002.
