# Local node runtime isolation plan

> **Status:** Implemented on `feat/local-node-runtime-isolation`; release-publication
> evidence is enforced by tag CI
> **Primary outcome:** Recreating or upgrading Shepherd's control plane must not stop an
> active agent on the bundled local node.
> **Companion documents:** [architecture.md](architecture.md),
> [state ownership](architecture/state-ownership.md),
> [agent daemon compatibility and upgrade plan](agentd-compatibility-and-upgrade-plan.md),
> and [deployment.md](deployment.md).

## 1. Executive summary

The production `orchestrator` container currently owns two different lifecycles:

1. Shepherd's control plane: API, authentication, database migrations, SSH connections,
   WebSockets, status reconciliation, Git orchestration, and Preview routing.
2. The bundled local node: `flock-agentd`, coding-agent CLIs, agent processes, PTYs,
   workspaces, credentials, daemon identity, and daemon supervision.

That coupling means a normal orchestrator container replacement also terminates the local
daemon and its child sessions. Remote-node sessions can survive the same control-plane
restart because their daemon lives elsewhere; local sessions cannot. It also forces the
orchestrator image to contain agent CLIs and retain root-level runtime responsibilities.

The target architecture introduces a separately versioned `node-runtime` service and
`shepherd-node-runtime` image. It owns the local daemon and every resource needed by local
agent sessions. The orchestrator reaches it through an authenticated Unix socket and uses
daemon capabilities for node-local command execution and loopback TCP tunnels. The
orchestrator no longer mounts the agent home, launches local commands, installs coding
agents, supervises `flock-agentd`, or shares the runtime container lifecycle.

The first topology migration cannot preserve already-running local PTYs because they are
children of the old orchestrator container. The upgrade must therefore detect and drain
local sessions before the one-time cutover. After that cutover, supported runtime versions
remain pinned during ordinary control-plane upgrades, so active local sessions survive.

## 2. Problem statement

### Current ownership

| Concern                             | Current owner                                    | Problem                                                                              |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Orchestrator process and migrations | `orchestrator` container                         | Correct owner                                                                        |
| Local `flock-agentd` process        | `orchestrator` entrypoint supervisor             | Dies when the control plane is replaced                                              |
| Local agent processes and PTYs      | Child processes of bundled `flock-agentd`        | Die with the bundled daemon                                                          |
| Local agent CLIs                    | Orchestrator image and startup entrypoint        | Bloats the trusted control-plane image and couples CLI changes to API releases       |
| Local agent home/workspaces         | `flock_agent_home`, mounted into orchestrator    | Control plane has more workspace access than it needs                                |
| Daemon identity/control secret      | `flock_agentd_state`, mounted into orchestrator  | Runtime and control state have no container boundary                                 |
| Local Git/filesystem commands       | `LocalTransport` child processes in orchestrator | Commands execute in the wrong lifecycle and namespace after a split                  |
| Local Preview TCP access            | Orchestrator loopback                            | `127.0.0.1` stops referring to the local node after a split                          |
| Local hook delivery                 | Public/orchestrator URL from the same container  | Must be made explicit across the new boundary                                        |
| Stack version                       | One `FLOCK_VERSION` for every image              | A routine release would recreate the runtime even when its daemon remains compatible |

### Concrete failure

`docker compose up`, `docker compose restart orchestrator`, or a forced orchestrator
recreation stops the entrypoint's daemon supervisor. Daemon shutdown closes its in-memory
session manager and terminates the agent PTYs. Reconciliation can report that loss, but it
cannot restore those processes. This conflicts with Shepherd's core promise that the node,
not the browser or orchestrator, owns the live session.

### Root cause

This is a process-ownership problem, not a reconnect timing problem. More retries inside
the browser or orchestrator cannot preserve a process that the container replacement has
already killed.

## 3. Goals, non-goals, and invariants

### Goals

- Recreate `orchestrator`, `web`, or `caddy` while a local session is active and reconnect
  to the same uninterrupted daemon session afterward.
- Make local and SSH nodes follow the same architectural rule: the node runtime owns live
  work; the orchestrator is an authenticated controller and viewer.
- Keep the local runtime on a separately pinned version so compatibility policy, rather
  than release-number equality, decides when it must restart.
- Move agent CLIs, runtime-user setup, workspaces, PTYs, and local loopback services out of
  the trusted control-plane container.
- Preserve local filesystem, Git, metrics, terminal, and Project Preview capabilities.
- Make the one-time topology migration explicit, session-safe, reversible where possible,
  and honest about unavoidable local-session interruption.
- Remove the obsolete in-process local execution path after the cutover.

### Non-goals

- Preserving a session through a `node-runtime` or `flock-agentd` restart. Agentd restart
  reattachment is a separate roadmap item; until then, a runtime restart is a
  session-affecting maintenance action.
- Giving the orchestrator access to Docker or mounting `/var/run/docker.sock`.
- Turning the local runtime into a general-purpose remote shell service.
- Renaming stable `FLOCK_*` environment variables, volume names, database identifiers, or
  the `flock-agentd` protocol surface as part of this change.
- Replacing the existing SSH-node provisioning model.
- Claiming zero downtime for the first release that moves the bundled daemon out of the
  old orchestrator container.

### Non-negotiable invariants

1. **The runtime owns live work.** No local agent, PTY, workspace command, or Preview
   loopback connection executes in the orchestrator container.
2. **No implicit session destruction.** Shepherd tooling never recreates a runtime with
   active sessions unless the operator uses an explicit force option that names the
   affected sessions.
3. **No secret widening.** The runtime receives no database password, master key, setup
   token, login cookie secret, SSH private key, or Docker socket.
4. **No root execution for agent work.** Daemon control may start with narrowly required
   privileges, but every agent and node command runs as the unprivileged runtime user.
5. **Compatibility, not exact equality.** A supported older runtime is not restarted just
   because the control-plane release is newer.
6. **The node remains authoritative.** PostgreSQL records identity and history; daemon
   inventory remains authoritative for which local sessions are actually live.
7. **No false durability claim.** A stopped runtime produces a precise disconnected/lost
   state, never an infinite spinner or a claim that its PTYs survived.

## 4. Target architecture

```text
Browser
   |
   v
Caddy ----> Web
   |
   v
Orchestrator ----> PostgreSQL
   |                    (durable management state)
   |
   +-- authenticated Unix socket on shared control volume
   v
Node runtime (`shepherd-node-runtime`)
   +-- flock-agentd
   +-- unprivileged agent processes and PTYs
   +-- Codex / Claude Code / OpenCode and node-side tools
   +-- local workspaces and tool credentials
   +-- loopback development servers used by Project Preview
```

### Service responsibility matrix

| Responsibility                                    | `orchestrator`            | `node-runtime`                      |
| ------------------------------------------------- | ------------------------- | ----------------------------------- |
| HTTP/API/WS, auth, audit, database migrations     | Owns                      | None                                |
| PostgreSQL and encrypted application secrets      | Uses                      | No access                           |
| SSH-node connections and daemon rollout artifacts | Owns                      | None                                |
| Local daemon lifecycle                            | Connects only             | Owns                                |
| Local coding-agent CLIs                           | None                      | Owns                                |
| Local PTYs and processes                          | None                      | Owns                                |
| Local agent home/workspaces                       | No mount                  | Exclusive read/write mount          |
| Daemon internal state                             | No write access           | Exclusive read/write mount          |
| Daemon control socket and credential              | Read/connect only         | Creates and owns                    |
| Local Git/filesystem commands                     | Requests over agentd      | Executes as runtime user            |
| Local Preview loopback dial                       | Requests an agentd tunnel | Dials loopback in runtime namespace |
| Docker socket                                     | No access                 | No access                           |

### Volumes

- Keep `flock_agent_home` and `flock_agentd_state` under their existing names so an
  upgrade reuses data instead of silently creating empty storage.
- Mount `flock_agent_home` read/write only in `node-runtime`.
- Mount `flock_agentd_state` read/write only in `node-runtime`. Do not expose daemon
  internal session/layout state to the control plane.
- Add `flock_agentd_control`, mounted read/write by `node-runtime` and read-only where
  supported by `orchestrator`. It contains only the Unix socket, stable node identity,
  and protected control credential.
- The runtime must remove a stale socket before binding while preserving the credential
  and node identity across container recreation.
- Validate that the target container engine permits connecting to a Unix socket through a
  read-only volume mount. If an engine does not, mount only the control volume read/write
  in the orchestrator while preserving file ownership/modes and documenting why; never
  broaden access to agent home or daemon state.

### Networks

- Publish no runtime ports.
- Attach the runtime only to a dedicated runtime network that permits required outbound
  access for coding-agent APIs and Git remotes.
- Do not attach the runtime to the PostgreSQL `data` network.
- Do not attach it to the public `edge` network unless hook delivery testing proves that
  no narrower route works.
- If local hook callbacks require a shared internal network, expose only the orchestrator
  HTTP service there. All normal API routes retain authentication; the hook route retains
  its per-session token. Document this boundary and test that agents cannot reach
  PostgreSQL or control secrets.

## 5. Key technical decisions

### 5.1 Use agentd for all local-node operations

Moving only the PTY daemon is insufficient. `LocalTransport` currently executes Git,
filesystem, and related commands in the orchestrator process, while Preview dials the
orchestrator's loopback. Both would target the wrong container after separation.

Add two authenticated, capability-gated agentd operations:

- `exec_v1`: bounded non-interactive command execution as the runtime user.
- `tcp_tunnel_v1`: a dedicated authenticated connection that dials only numeric loopback
  addresses inside the runtime namespace and relays bytes with backpressure.

These are additive capabilities, not a protocol-version bump unless the frame contract
cannot remain backward compatible. Do not add them to the global minimum capability set
for SSH nodes merely to support the bundled runtime. Older remote daemons may continue to
use SSH for command and TCP transport during their supported window.

### 5.2 Use dedicated connections for bulk operations

Do not send Preview traffic or large command output through the long-lived connection that
carries PTY and status frames. Each `exec_v1` request and TCP tunnel should authenticate on
its own Unix-socket connection. This prevents a busy dev server or slow HTTP client from
starving terminal output for every session on the node.

### 5.3 Separate control-plane and runtime versions

Add a runtime image pin such as `FLOCK_NODE_RUNTIME_VERSION`. A fresh install pins it to
the release's preferred runtime. An upgrade changes `FLOCK_VERSION` independently and
changes the runtime pin only when policy and active-session inventory allow it.

The target release manifest must declare:

- Shepherd release version;
- preferred and minimum local runtime/daemon versions;
- supported daemon protocols and required capabilities;
- deployment topology generation;
- immutable image digests for all release images;
- whether moving to the topology requires a local-session drain.

Do not infer a safe runtime restart from a matching marketing version.

### 5.4 Keep remote rollout artifacts in the control plane

The orchestrator still needs checked, multi-architecture `flock-agentd` artifacts to
provision and upgrade SSH nodes. It may retain `/app/agentd/dist`, `VERSION`, and
`COMPATIBILITY.json`, but it must not retain the local daemon executable, agent CLIs,
runtime user home, or supervisor.

Use one checked build script/source path for daemon artifacts so the runtime executable
and remote rollout binaries are stamped from the same `agentd/VERSION`. Release validation
must compare their reported versions and digests.

### 5.5 Treat the first cutover as maintenance

There is no safe in-place transfer of an existing PTY from the daemon inside the old
orchestrator container to a new daemon in another container. The first topology upgrade
must:

1. inventory local sessions from the old authenticated daemon;
2. block while any are active;
3. preserve remote sessions;
4. stop the old orchestrator only after the local count reaches zero;
5. start the runtime against the existing home/state volumes;
6. verify the same local node identity and control credential;
7. start the new orchestrator and reconcile.

A force path may exist for recovery, but it must print the exact affected session IDs and
require an explicit `--force-stop-local-sessions` option. A generic `--yes` is not enough.

## 6. Phased implementation

Each task should be a reviewable change with its tests. Do not merge the production
Compose cutover until the daemon capabilities and survival test harness are green.

### Phase 0 — Architecture contract and executable baseline

#### LRI-001 — Record the lifecycle decision

- [x] Add an ADR declaring `node-runtime` the owner of local live work.
- [x] Update the state-ownership inventory with runtime home, daemon state, control
      identity/credential, Unix socket, and live PTY ownership.
- [x] Document the exact failure guarantees for orchestrator loss, runtime loss, host
      reboot, and database loss.
- [x] State explicitly that daemon restart recovery remains separate work.

**Reasoning:** Tests and code need one authoritative answer about process and state
ownership. Without it, later refactors can quietly remount the workspace or restart the
runtime during ordinary upgrades.

**Definition of done:** Architecture review can answer who owns every local-node process,
file, credential, socket, and version pin without referring to implementation folklore.

#### LRI-002 — Add a real lifecycle acceptance harness

- [x] Replace comments and optional/skipped restart checks with a deterministic
      production-Compose integration test.
- [x] Start a local shell session that emits a unique sentinel and records its shell PID.
- [x] Force-recreate only the orchestrator container.
- [x] Reauthenticate, attach to the same session ID, and verify the same shell PID and
      continued sentinel output.
- [x] Add the inverse test: stopping `node-runtime` marks the session unavailable with a
      precise terminal state.

**Reasoning:** The core outcome must be proven by process identity, not by a WebSocket
success response or a persisted database row.

**Definition of done:** The survival test fails against the current bundled topology for
the expected reason and becomes a mandatory release smoke after the cutover.

### Phase 1 — Agentd node-operation capabilities

#### LRI-101 — Implement bounded `exec_v1`

- [x] Extend Go and TypeScript protocol contracts with request ID, argv, cwd, sanitized
      environment, optional stdin, timeout, output limits, exit code, signal, truncation
      flags, and structured errors.
- [x] Reject empty argv, invalid working directories, NUL bytes, oversized input,
      excessive environment size, and timeouts beyond a server hard cap.
- [x] Execute only as the configured runtime identity with a clean environment policy.
- [x] Strip every `FLOCK_AGENTD_*` credential/control variable from the child.
- [x] Kill the entire command process group on timeout or client disconnect.
- [x] Bound stdout and stderr independently and report truncation instead of growing
      memory without limit.
- [x] Advertise `exec_v1` only when the implementation is active.

**Reasoning:** Git and filesystem operations must execute where the workspace lives, but
an arbitrary root command RPC would destroy the privilege boundary.

**Definition of done:** Git status/diff and node filesystem probes execute inside the
runtime as the unprivileged user; control secrets never appear in child environment or
output; timeout and output caps are deterministic.

#### LRI-102 — Implement `tcp_tunnel_v1`

- [x] Authenticate every tunnel connection before accepting a target.
- [x] Accept only `127.0.0.1` or `::1` and ports 1-65535.
- [x] Use a dedicated socket connection per tunnel.
- [x] Implement connect timeout, half-close, cancellation, idle timeout, maximum lifetime,
      bounded buffering, and end-to-end backpressure.
- [x] Enforce per-node concurrent-tunnel limits in addition to the orchestrator's Preview
      limits.
- [x] Ensure target validation occurs again in agentd; never trust the orchestrator alone.
- [x] Advertise `tcp_tunnel_v1` only when active.

**Reasoning:** A TCP dial from the orchestrator reaches the wrong loopback after the
container split. The tunnel must originate in the node namespace without becoming an
SSRF primitive or starving terminal traffic.

**Definition of done:** Project Preview reaches a server bound only to the runtime's
`127.0.0.1`; attempts to dial non-loopback targets are rejected and audited/diagnosed.

#### LRI-103 — Add an agentd-backed local node transport

- [x] Add a narrowly composed local transport using `exec_v1` and `tcp_tunnel_v1`.
- [x] Split the broad `NodeTransport` interface into capability-oriented interfaces if
      needed so non-PTY command and TCP consumers do not depend on an unused raw-PTY method.
- [x] Make Git, diff, filesystem browsing, workspace intelligence, and Preview use the
      capability they actually require.
- [x] Preserve SSH transports and their compatibility fallback during the supported
      daemon window.
- [x] Return structured capability-unavailable errors that the API and UI can explain.

**Reasoning:** One giant transport interface encourages fake methods and hides which node
features are actually available.

**Definition of done:** No production local-node feature uses `child_process`, `node-pty`,
or orchestrator loopback to act on the node.

### Phase 2 — Runtime image and container boundary

#### LRI-201 — Build `shepherd-node-runtime`

- [x] Add a multi-architecture runtime Dockerfile based on a pinned minimal image.
- [x] Install `flock-agentd`, Git/node-side tools, Codex, OpenCode, and the existing
      best-effort latest Claude Code installer policy.
- [x] Create stable control/runtime UID and GID values compatible with existing volumes.
- [x] Move runtime-user setup and agent-version inventory from the orchestrator image.
- [x] Add OCI source, version, revision, and MIT license labels.
- [x] Run as read-only root filesystem with explicit writable volumes/tmpfs only.
- [x] Determine and document the minimum Linux capabilities empirically. Retain only what
      is required to switch identity, signal child processes, and manage owned files.
- [x] Use Docker restart policy for daemon process failure; avoid an unnecessary nested
      forever-loop supervisor if the daemon can be PID 1 safely.
- [x] Add an authenticated daemon probe (not just `test -S`) for container health.

**Reasoning:** The runtime image is a node appliance. It should contain node tools and
privileges, while the trusted control plane should not.

**Definition of done:** The image starts healthy on amd64 and arm64, launches all
supported agent types as the runtime user, and contains no application/database secrets or
orchestrator server bundle.

#### LRI-202 — Split the entrypoints

- [x] Create a runtime entrypoint that initializes only the control credential, stable
      node ID, socket directory, optional CLI update, and daemon.
- [x] Reduce the orchestrator entrypoint to secret staging, database URL construction,
      migrations, and `exec` of the non-root control process.
- [x] Remove daemon supervision, agent CLI installation, runtime user/home setup, and
      socket creation from the orchestrator entrypoint.
- [x] Make signal handling and grace periods explicit for each service.
- [x] Ensure a failed CLI update does not corrupt an existing binary or prevent daemon
      startup.

**Definition of done:** Stopping orchestrator never sends a signal to agentd; stopping
runtime cleanly reports that it is session-affecting.

#### LRI-203 — Wire production Compose

- [x] Add `node-runtime` with no published ports, no Docker socket, no database network,
      and no control-plane secrets.
- [x] Mount existing home/state volumes exclusively into the runtime.
- [x] Add and permission the shared control volume.
- [x] Make initial orchestrator startup wait for authenticated runtime health without
      creating a permanent restart dependency.
- [x] Use a separate runtime version variable/image pin.
- [x] Add resource limits, health check, restart policy, logging, tmpfs, read-only root,
      and `no-new-privileges` settings appropriate to the runtime.
- [x] Update TLS, private HTTP, external proxy, DNS-provider, local, and development
      Compose variants so they retain the same service boundary.
- [x] Assert rendered Compose configuration in deployment tests.

**Definition of done:** `docker compose config` shows no agent home/state mount and no
agent CLI policy in orchestrator; the runtime has no host port, database secret, master
key, setup token, SSH key, or Docker socket.

### Phase 3 — Control-plane cutover and cleanup

#### LRI-301 — Connect local lifecycle through agentd

- [x] Build local node status from the authenticated daemon link instead of hard-coding
      local as connected.
- [x] Reconnect with bounded backoff after orchestrator recreation.
- [x] Re-list live daemon sessions and reconcile the existing database records.
- [x] Keep existing sessions attachable while a supported older runtime is connected.
- [x] Make node info, metrics, detected agents, capability state, and daemon compatibility
      come from the runtime daemon.
- [x] Keep control credential rotation atomic across the shared volume and active
      connections.

**Definition of done:** Orchestrator memory can be discarded and rebuilt without changing
the local daemon session inventory or node identity.

#### LRI-302 — Move every local feature across the boundary

- [x] Route Git status/diff/branch/commit/push/PR commands through `exec_v1`.
- [x] Route filesystem browsing and workspace inspection through `exec_v1`.
- [x] Route Project Preview probing and data connections through `tcp_tunnel_v1`.
- [x] Define and validate the local hook callback route for built-in TLS, external proxy,
      private Tailnet HTTP, IP-only local, and development deployments.
- [x] Verify agent configuration and credentials continue to live in the runtime home.
- [x] Confirm autonomous-session sandbox checks occur in the runtime namespace.

**Definition of done:** Terminal, Git, files, metrics, hooks, sandbox detection, and
Preview all work for the local node with no workspace mount in orchestrator.

#### LRI-303 — Remove the obsolete bundled path

- [x] Delete production use of `LocalTransport` and remove the class if no explicit test
      or development consumer remains.
- [x] Remove `node-pty` from the orchestrator when no remaining code needs it.
- [x] Remove local `flock-agentd`, Codex, OpenCode, Claude installer, runtime user, and
      agent home from the orchestrator image.
- [x] Remove obsolete environment variables, comments, tests, and documentation that say
      the local node is the orchestrator container.
- [x] Update architecture/dead-code rules so the dependency cannot silently return.
- [x] Keep remote daemon artifacts and compatibility metadata intentionally.

**Definition of done:** Dead-code and dependency checks pass; searching the orchestrator
image/config finds no local daemon supervisor or coding-agent executable.

### Phase 4 — Session-safe upgrades and release distribution

#### LRI-401 — Introduce a deploy/release manifest

- [x] Publish a signed/checksummed deployment bundle with the release's Compose files,
      helper scripts, release manifest, and compatibility manifest.
- [x] Add a topology generation and separate runtime image digest/version.
- [x] Validate the bundle before modifying a deployment directory.
- [x] Stage new deployment files, run `docker compose config`, and switch atomically only
      after preflight succeeds.
- [x] Preserve `.env`, secret files, volumes, custom overrides, and a copy of the previous
      deployment definition.

**Reasoning:** Pulling new images cannot introduce a new Compose service. Existing
installations need a versioned deployment definition, not only a new image tag.

**Definition of done:** An operator can move from the last bundled-runtime release to the
new topology without manually editing Compose YAML.

#### LRI-402 — Make upgrades runtime-aware

- [x] Query the authenticated local daemon for version, protocol, capabilities, and exact
      active-session IDs before changing any version pin.
- [x] Leave a compatible runtime pin unchanged during an ordinary control-plane upgrade.
- [x] Allow a recommended runtime upgrade to defer until the node is idle.
- [x] Block a required runtime upgrade while sessions are active unless the current
      control plane can safely attach and drain them.
- [x] Never automatically downgrade a newer compatible runtime.
- [x] Add explicit `--force-stop-local-sessions`; print affected IDs and record the
      maintenance decision.
- [x] Start/recreate only the services that need changing. Do not use a blanket stack
      recreation as the normal path.
- [x] Verify control-plane readiness, runtime compatibility, and daemon reconnection after
      every step.

**Definition of done:** A control-plane-only upgrade leaves the runtime container ID,
daemon PID, session IDs, and agent PIDs unchanged.

#### LRI-403 — Implement the one-time migration

- [x] Detect the legacy bundled topology reliably.
- [x] Refuse migration with active local sessions and leave the old stack untouched.
- [x] Create and verify the normal encrypted database vault.
- [x] Warn that `flock_agent_home` needs its separate operator-managed backup, as it does
      today.
- [x] Reuse the existing home/state volumes and preserve ownership.
- [x] Move or copy the stable node ID/control credential into the control volume with an
      atomic, idempotent step.
- [x] Start runtime first, authenticate it, compare identity, then start orchestrator.
- [x] On failure before database migration, restore the old deployment definition and
      version pins. After database migration, print schema-aware recovery guidance rather
      than claiming an unsafe automatic downgrade.
- [x] Add an integration fixture for the immediately previous release topology.

**Definition of done:** Files and agent logins in the old local home remain present; the
local node keeps its identity; no duplicate local node row is created; the migration is
idempotent after interruption.

#### LRI-404 — Extend release automation

- [x] Build `shepherd-node-runtime` for linux/amd64 and linux/arm64.
- [x] Generate SBOM and provenance attestations and apply the same vulnerability gate as
      every other public image.
- [x] Record and promote the exact tested digest.
- [x] Verify anonymous GHCR access.
- [x] Move coding-agent version annotations/inventory from the orchestrator artifact to
      the runtime artifact.
- [x] Include runtime image/version consistency in `release:check`.
- [x] Smoke the exact candidate images, including local session survival across a forced
      orchestrator recreation.

**Definition of done:** A release cannot publish unless the exact public runtime image was
scanned, attested, tested with the other exact candidate images, and proven to preserve a
session across control-plane replacement.

### Phase 5 — Operations, UX, and documentation

#### LRI-501 — Surface runtime health clearly

- [x] Show local runtime reachable/unreachable, daemon version, protocol, capabilities,
      compatibility state, last successful handshake, and active-session count on Node
      details and diagnostics.
- [x] Distinguish “control plane unavailable,” “local runtime unavailable,” “runtime
      upgrade recommended,” and “runtime upgrade required.”
- [x] For immutable local runtime upgrades, show the exact operator command rather than a
      UI button that implies Shepherd has Docker access.
- [x] Explain when an upgrade is deferred to protect active sessions.
- [x] Emit structured counters/logs for connect failures, authentication failures,
      command truncation/timeouts, tunnel rejection, and deferred maintenance.

**Definition of done:** A user can diagnose a broken local runtime without reading raw
container logs, and the UI never offers a destructive or impossible action.

#### LRI-502 — Update operational documentation

- [x] Update README quick start and architecture overview.
- [x] Update deployment scenarios and their Compose commands.
- [x] Update backup/restore ownership for runtime home, daemon state, and control volume.
- [x] Document control-plane-only upgrade, deferred runtime upgrade, forced maintenance,
      rollback boundaries, and first topology migration.
- [x] Update security documentation with the runtime trust boundary and minimum
      capabilities.
- [x] Update troubleshooting for socket permissions, credential mismatch, runtime health,
      and Preview/hook routing.
- [x] Add release notes that plainly state the one-time local-session drain requirement.

**Definition of done:** A fresh installer and an existing operator can reach the correct
outcome without knowing Shepherd's container internals.

## 7. Detailed security requirements

### Container and filesystem isolation

- The runtime has a read-only root filesystem.
- Writable locations are limited to runtime home, daemon state, daemon control, and
  explicit tmpfs mounts.
- The orchestrator cannot read or write runtime home or daemon internal state.
- The runtime cannot read application secrets or the database network.
- Neither service receives a Docker socket.
- Stable UID/GID ownership is validated on fresh and migrated volumes.

### Control channel

- Preserve mutual nonce/MAC authentication on every socket connection.
- Keep the credential at group-readable minimum permissions and exclude the runtime user.
- Bind authenticated identity to stable node ID, daemon version, protocol, and
  capabilities.
- Reject stale/unknown credentials without falling back to unauthenticated local trust.
- Make credential rotation crash-safe and test old/new overlap behavior.

### Command execution

- Execute as the runtime user and never accept a caller-supplied UID/GID.
- Apply current agent environment redaction to every command.
- Cap argv, cwd, environment, stdin, stdout, stderr, and execution time.
- Kill process groups on timeout/disconnect and reap children.
- Preserve argv boundaries; never interpolate commands through a shell unless an explicit
  reviewed caller requests a shell executable as argv.
- Return redacted structured errors rather than leaking control environment values.

### TCP tunneling

- Permit only numeric loopback targets and validated ports.
- Resolve no hostnames and follow no redirects at the tunnel layer.
- Apply concurrency, connection, idle, lifetime, and buffer limits.
- Keep Preview HTTP security controls, origin isolation, header filtering, request/response
  limits, and capability TTLs in the orchestrator.
- Prove that tunnel traffic cannot reach PostgreSQL, the Docker API, cloud metadata, or a
  non-loopback host.

## 8. Testing and validation matrix

### Unit tests

- Go/TypeScript protocol parity for `exec_v1` and `tcp_tunnel_v1`.
- Authentication required on every operation connection.
- Exec input validation, environment stripping, identity drop, output truncation,
  timeout, disconnect cancellation, signal reporting, and process-group cleanup.
- TCP target validation, connect failure, half-close, idle timeout, lifetime cap,
  concurrency limit, backpressure, and cancellation.
- Runtime compatibility decisions below/equal/above minimum and preferred versions.
- Upgrade decision matrix for compatible/recommended/required plus zero/nonzero sessions.
- Local transport capability errors and API error mapping.
- Local node lifecycle reducer and reconnection state.

### Integration tests

- Shared Unix socket and credential work with real container UID/GID permissions.
- A wrong credential and wrong node ID fail closed.
- Git and filesystem commands run in runtime-only files invisible to orchestrator.
- Agent command environment cannot observe control credentials.
- A runtime-loopback HTTP server is reachable through Preview and unreachable by direct
  orchestrator loopback.
- Hook callbacks work in every supported deployment mode.
- Orchestrator restart reconnects and re-lists a live runtime session.
- Runtime stop produces an honest disconnected/lost state.
- Credential rotation preserves a valid active overlap and rejects the retired key.

### Compose and image tests

- Render every supported Compose combination with `docker compose config`.
- Assert runtime has no public ports, data network, app secrets, SSH keys, or Docker socket.
- Assert orchestrator has no agent home/state mount, agent CLI, local daemon binary, or
  supervisor.
- Inspect image users, capabilities, writable paths, labels, health checks, and
  architecture manifests.
- Scan both architectures and retain full reports.

### End-to-end acceptance tests

1. Start a local shell/agent session and capture session ID, daemon PID, and agent PID.
2. Produce terminal output and a durable workspace sentinel.
3. Force-recreate orchestrator and web only.
4. Log in again and attach to the same session.
5. Verify daemon PID, agent PID, session ID, terminal continuity, and workspace state are
   unchanged.
6. Verify Git, files, metrics, hooks, and Preview still work.
7. Confirm runtime container ID did not change.

### Upgrade tests

- Legacy topology with no active local sessions migrates and preserves home, credentials,
  node identity, projects, and history.
- Legacy topology with an active local session refuses before mutation.
- Forced legacy migration names and terminates only the acknowledged local sessions.
- A supported old runtime stays pinned across a newer control-plane upgrade.
- A recommended runtime upgrade defers while active and succeeds after drain.
- A mandatory incompatible runtime blocks safely with actionable guidance.
- A newer compatible runtime is never downgraded.
- Failure before cutover restores the prior deployment definition; failure after database
  migration emits correct recovery guidance.

### Required quality gates

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:int
pnpm build
pnpm quality:dead-code
pnpm quality:architecture
pnpm quality:duplicates
pnpm quality:bundle
pnpm release:check
pnpm test:e2e
cd agentd && go build ./... && go vet ./... && go test -race ./...
docker compose config --quiet
git diff --check
```

Live validation must also run on the local production-style stack and at least one real
SSH/Vagrant node so the new local capabilities do not regress remote provisioning or
daemon compatibility.

## 9. Failure and rollback behavior

| Failure                                            | Required behavior                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Orchestrator fails/restarts                        | Runtime and sessions continue; clients reconnect after control-plane recovery                      |
| Web/Caddy fails/restarts                           | Runtime and sessions continue                                                                      |
| Runtime link authentication fails                  | Local node shows a credential/identity error; no unauthenticated fallback                          |
| Runtime container exits                            | Docker restarts it, but current sessions are reported lost/disconnected; do not claim reattachment |
| Runtime upgrade requested with sessions            | Refuse/defer and list affected sessions                                                            |
| Runtime candidate is unhealthy                     | Keep or restore prior runtime pin when safe; never loop destructive restarts                       |
| First topology migration fails before DB migration | Restore prior deployment definition and version pins                                               |
| Migration fails after DB migration                 | Preserve data and print schema-aware recovery steps; do not auto-run an unsafe old image           |
| Preview tunnel fails                               | Terminal/session remain unaffected; show a scoped Preview error                                    |
| Exec command exceeds limits                        | Kill command tree, return structured timeout/truncation state, keep daemon healthy                 |

## 10. Delivery sequence and dependencies

```text
LRI-001 -> LRI-002
             |
             +-> LRI-101 -> LRI-103 --+
             +-> LRI-102 ------------+-> LRI-301 -> LRI-302 -> LRI-303
                                      |
LRI-201 -> LRI-202 -> LRI-203 --------+

LRI-401 -> LRI-402 -> LRI-403
                    -> LRI-404 (after production cutover tests)

LRI-501 and LRI-502 complete before release.
```

Recommended review slices:

1. ADR, state ownership, and failing lifecycle acceptance test.
2. Agentd `exec_v1` with protocol/security tests.
3. Agentd `tcp_tunnel_v1` with protocol/security tests.
4. Agentd-backed local transport and feature integration behind test-only wiring.
5. Runtime image/entrypoint and Compose boundary.
6. Production cutover, lifecycle reconciliation, and deletion of the old path.
7. Deployment bundle and session-aware upgrade workflow.
8. Release pipeline, UX, documentation, and full live validation.

Do not maintain two production local-runtime implementations after slice 6. A short-lived
development flag is acceptable while building the boundary, but it must be removed before
release.

## 11. Overall definition of done

This initiative is complete only when all of the following are true:

- A forced orchestrator recreation preserves the same active local session, daemon PID,
  agent PID, and terminal continuity.
- Ordinary control-plane upgrades do not recreate a compatible local runtime.
- Runtime upgrades are separately pinned, compatibility-aware, and blocked/deferred while
  sessions are active.
- The one-time legacy migration refuses active local sessions before mutation and
  preserves existing local home/state when drained.
- Local terminal, Git, files, metrics, hooks, sandbox checks, and Project Preview work
  through the runtime boundary.
- The orchestrator image contains no local coding-agent CLI, local daemon executable,
  runtime user home, daemon supervisor, or `node-pty` dependency.
- The runtime has no public port, Docker socket, database access, or application secrets.
- The exact runtime candidate image is multi-architecture, public, scanned, attested, and
  included in release consistency checks.
- Runtime loss and incompatibility produce precise, actionable UI/API states.
- Architecture, deployment, backup/recovery, security, upgrade, troubleshooting, and
  release documentation describe the new ownership model accurately.
- Every automated quality gate and the production-style lifecycle acceptance test pass.

The decisive acceptance test is intentionally simple: start a local agent, force-recreate
the control plane, and return to the same uninterrupted terminal. If that does not work,
the lifecycle boundary is not complete.

## 12. Implementation evidence

Validated on 2026-07-15 from a fresh, isolated production-style Compose installation;
the existing `11010` installation was not used or modified.

- **Lifecycle:** A terminal session emitted
  `SHEPHERD_FINAL_SURVIVAL_SENTINEL`. Force-recreating only `orchestrator` preserved the
  runtime container, daemon start time, session ID, agent PID (`153`), and terminal
  scrollback. Reattaching through a new authenticated WebSocket replayed the sentinel.
- **Inverse failure:** Stopping `node-runtime` changed the local node to disconnected and
  returned HTTP 503 with `local_runtime_unavailable`. Restarting it did not claim that
  daemon-owned processes survived.
- **Runtime boundary:** The runtime had one private runtime network, no published ports,
  database network, application secrets, SSH keys, or Docker socket. The orchestrator
  had only the read-only control volume and contained no local agent daemon, coding-agent
  CLI, runtime home, or local PTY implementation.
- **Feature parity:** Git, filesystem, workspace search, metrics, terminal attach,
  callback routing, and a real loopback HTTP Preview passed through authenticated
  `exec_v1`/`tcp_tunnel_v1` operations. The Preview target was unreachable from
  orchestrator loopback.
- **Migration and upgrade:** The legacy-volume migration fixture preserved home data,
  identity, and credential bytes across repeated starts. The upgrade workflow validated
  bundles and authenticated runtime facts, protected active session IDs, preserved pins,
  and exercised rollback boundaries.
- **Remote regression:** A fresh Ubuntu 22.04 Vagrant node was provisioned with agentd
  0.5.0/protocol 2, reported compatible agent inventory, launched a remote PTY, and
  exchanged terminal output. The disposable session, enrollment, and VM were then
  cleaned up.
- **Automated gates:** 1,255 unit tests, 128 containerized integration tests, 42
  Chromium/WebKit end-to-end tests, Go build/vet/race tests, TypeScript build/typecheck,
  ESLint, Prettier, dead-code, architecture, duplicate-code, bundle, performance,
  documentation, release-consistency, migration, Compose, and diff checks passed.

The release-only items marked complete above mean the repository now enforces them: the
tag workflow builds both architectures, generates SBOM/provenance, scans, smokes exact
candidate digests, promotes only those digests, and verifies anonymous GHCR access before
publishing a GitHub release. This branch validation does not claim that a new public tag
or GHCR manifest has already been published.
