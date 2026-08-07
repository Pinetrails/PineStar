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
`shell.bg.status`, `shell.bg.read`, `shell.bg.write`, `shell.bg.kill`, checkpoints, and `fs.*` all keep working.

### `docker`

Opt-in. Each agent gets one deterministically named, ownership-labeled Docker container with its workspace
bind-mounted at `/workspace`. StarNet inspects and reuses that container across commands and sidecar restarts;
it creates, starts, and probes the container on first use when no owned environment exists:

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
- writable-layer persistence for installed packages and container caches
- container cwd persistence under `/workspace`, including sidecar restarts
- `shell.exec background:true` plus status, paged logs, stdin, EOF, and kill through the existing background manager
- capability drop, `no-new-privileges`, and a PID limit by default
- deterministic container names plus `ai.starnet.managed`, workspace, and agent ownership labels
- an explicit startup probe before any command is accepted

The container is deliberately not removed on ordinary sidecar shutdown: that is what preserves its writable
layer. Backend owners can call `cleanupAgent(agentId)` for explicit removal, or
`cleanupAgent(agentId, { remove:false })` to stop it without deleting state. Background process records remain
owned by the sidecar process; a restart reuses the container but does not claim that an old interactive stdin or
log ring can be resumed.

## Runtime Status

The sidecar exposes the active execution cell at:

```text
GET /api/execution
```

The response names the backend, workspace mapping, background support, persistence contract, and safe-cell
controls. Docker availability is `unknown` before its first real probe, `ready` after a successful probe, and
`unavailable` with the bounded failure reason after a failed probe. Local is the zero-friction default; Docker
is the opt-in hostile-code boundary.

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

the reference harness's production shape includes a richer environment manager with SSH, Modal, Singularity,
Daytona, idle cleanup, and file synchronization for non-bind-mounted backends. StarNet now has the same
architectural seam plus durable Docker reuse/background execution. The next parity steps are:

1. Add an owner-visible idle cleanup policy without deleting active or unowned containers.
2. Add SSH as the first non-local, non-container backend.
3. Add file sync for backends that cannot share the host workspace by bind mount.
4. Move checkpoint support behind environment capability flags for remote backends.
