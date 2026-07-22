# Execution Backends

StarNet's workbench tools now run through a single execution environment boundary. The shape is intentionally
ref-inspired: tools ask the active environment to execute, while the environment decides whether that means
the host shell or an isolated sandbox.

## Current Backends

### `local`

Default. Commands run on the host machine inside the agent's per-agent workspace:

```text
<WORKSPACES>/<agentId>/
```

This preserves the existing behavior: persistent cwd, `shell.exec`, `verify.run`, `shell.exec background:true`,
`shell.bg.status`, `shell.bg.kill`, checkpoints, and `fs.*` all keep working.

### `docker`

Opt-in. Foreground commands run in a one-shot Docker container with the agent workspace bind-mounted at
`/workspace`:

```powershell
$env:STARNET_EXEC_BACKEND = "docker"
$env:STARNET_DOCKER_IMAGE = "node:20-bookworm"
node sidecar/index.js
```

Docker execution currently supports:

- `shell.exec`
- `verify.run`
- shared `fs.*` workspace persistence via the host bind mount
- host-side checkpoints for the bind-mounted workspace
- container cwd persistence under `/workspace`
- capability drop, `no-new-privileges`, and a PID limit by default

Docker execution intentionally does not yet support background processes. `shell.exec` with `background:true`
returns a clear unavailable message while `local` remains the background-capable backend.

## Runtime Status

The sidecar exposes the active execution cell at:

```text
GET /api/execution
```

The response names the backend, workspace mapping, background support, and safe-cell controls. Local is the
zero-friction default; Docker is the opt-in hostile-code boundary.

Background subagents are managed above this environment seam. They can start on the local safe cell today, and
their durable records are exposed through:

```text
GET  /api/subagents
GET  /api/subagents?id=<subagentId>
POST /api/subagents/interrupt
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STARNET_EXEC_BACKEND` | `local` | `local` or `docker` |
| `STARNET_DOCKER_BIN` | `docker` | Docker-compatible executable |
| `STARNET_DOCKER_IMAGE` | `node:20-bookworm` | Image used for sandboxed commands |
| `STARNET_DOCKER_WORKSPACE` | `/workspace` | Container mount point |
| `STARNET_DOCKER_NETWORK` | empty | Optional Docker network value, for example `none` |
| `STARNET_DOCKER_CPUS` | empty | Optional Docker `--cpus` value |
| `STARNET_DOCKER_MEMORY` | empty | Optional Docker `--memory` value |
| `STARNET_DOCKER_SECURITY` | `true` | Adds `--cap-drop ALL`, `no-new-privileges`, and `--pids-limit 256` |
| `STARNET_DOCKER_EXTRA_ARGS` | `[]` | JSON string array of extra Docker args |

Legacy `SKYNET_EXEC_BACKEND`, `SKYNET_DOCKER_BIN`, and `SKYNET_DOCKER_IMAGE` are also accepted where applicable.

## Parity Direction

the reference harness's production shape includes a richer environment manager with Docker, SSH, Modal, Singularity, Daytona,
background process tracking, cleanup/reuse, and file synchronization for non-bind-mounted backends. StarNet now
has the same architectural seam, and the next parity steps are:

1. Add Docker background process tracking with status/log/kill.
2. Add long-lived Docker container reuse and idle cleanup.
3. Add SSH as the first non-local, non-container backend.
4. Add file sync for backends that cannot share the host workspace by bind mount.
5. Move checkpoint support behind environment capability flags for remote backends.
