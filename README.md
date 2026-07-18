# StarNet

StarNet is a local-first desktop harness where you create AI agents, organize them into a
pixel-art station, and watch them perform real work with real models and tools. The station is
not just decoration: rooms define capability-scoped teams, hallways define handoff paths, and
placed objects grant bounded tools.

> **Early release:** Windows is the most-tested desktop target. macOS and Linux builds use the
> same release train but have less real-world coverage. See [INSTALL.md](INSTALL.md) for current
> platform caveats, including operating-system signing warnings.

## Download

Desktop builds are published on the
[StarNet releases page](https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/latest).
Choose the installer for your platform and follow [the installation guide](INSTALL.md).

StarNet's updater verifies release artifacts with a key embedded in the app. That updater
signature protects artifact integrity; it is separate from Windows Authenticode and Apple
notarization, which are not yet enabled.

## Run from source

Requirements:

- Node.js 18 or newer (Node.js 22 is used by the release train)
- Git
- Rust and the Tauri prerequisites only if you want to build the desktop shell

The sidecar uses Node core modules, so it can run without installing npm dependencies:

```bash
git clone https://github.com/nonfungiblefunyuns-ship-it/skynet-harness.git
cd skynet-harness
node sidecar/index.js
```

Open <http://localhost:8787>, then connect a provider with your own API key or supported OAuth
sign-in. Provider requests leave your machine when you run an agent; station state, transcripts,
memory, and ledgers stay in the local StarNet workspace unless you explicitly use a network tool
or connector.

For desktop development:

```bash
npm ci
npm run desktop:dev
```

To build installers locally, install the platform-specific
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```bash
npm run desktop:build
```

## What is real

- Model calls stream through the local Node sidecar.
- Tools operate through explicit capability and consent checks.
- Agent memory, transcripts, spend records, tasks, and schedules persist on disk.
- Multiple agents can run concurrently with separate workspaces and bounded permissions.
- The visual station projects the same runtime state the harness can prove.

StarNet does not simulate revenue, completed work, model activity, or spend. Its core product law
is that the interface must never assert state the harness cannot prove.

## Architecture

| Path | Responsibility |
| --- | --- |
| `frontend/` | Vanilla JavaScript station world and desktop UI. |
| `sidecar/` | Local Node agent runtime, providers, tools, persistence, budgets, and consent. |
| `shared/` | Additive cross-boundary event and schema contracts. |
| `src-tauri/` | Rust/Tauri desktop shell and bundled runtime. |
| `test/` | Unit, contract, integration, and release gates. |
| `qa/` | Live QA receipts, journeys, findings ledger, and release-readiness authority. |

The frontend consumes real sidecar events over localhost HTTP/NDJSON and SSE. Secrets belong to
the sidecar or operating-system credential store and are never intentionally returned to the
renderer.

Start with [docs/INDEX.md](docs/INDEX.md) for the living documentation. Older planning documents
remain in the repository as design history and are labeled accordingly.

## Testing

```bash
npm run test:fast          # required merge gate
npm run test:http          # live sidecar HTTP/E2E suite
npm test                   # validation + world + fast + HTTP suites
npm run security:secrets   # full-history scan; requires Gitleaks in PATH
```

The release aggregate is `npm run qa:ready`. It is candidate-bound: any new commit invalidates
the prior READY receipt until the affected live gates are rerun.

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request,
and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) for private
reporting instructions.

## License

StarNet is available under the [MIT License](LICENSE).
