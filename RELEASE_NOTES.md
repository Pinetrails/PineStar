# StarNet v0.10.7

This hotfix repairs a critical Windows desktop lifecycle failure and tightens release isolation.

- Closing StarNet with the default close behavior now fully exits both the desktop shell and bundled sidecar instead of leaving an invisible background process that cannot be reopened.
- Close to tray remains opt-in; when enabled, StarNet stays resident and a relaunch or second launch reliably reveals the preserved station window.
- Image generation can now request an aspect ratio, including OpenRouter's native `image_config.aspect_ratio` path.
- Release and integration gates now run inside isolated scratch profiles so they cannot recover or ingest data from the installed StarNet station.
