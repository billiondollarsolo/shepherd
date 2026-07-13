# Decision: Privilege-separated agentd control plane

Status: Accepted
Date: 2026-07-11

## Context

The current remote daemon is installed as the same Unix user that runs coding agents.
Its shared secret is stored in a mode-`0600` file in that user's home. The local Docker
deployment likewise runs the orchestrator, agentd, and agent subprocesses under the
same `node` identity.

Mode `0600` protects a file from other UIDs, not from hostile child processes sharing
the owner UID. Removing the secret from the child environment is insufficient because
the child can still read same-user files and may inspect same-user process state. Once
authenticated, the agentd v1 protocol grants node-wide session control.

## Decision

Shepherd will use three distinct roles:

- **agentd service:** a system service with the minimum privilege needed to create a
  PTY and drop each child to the runtime identity;
- **Shepherd control client:** the orchestrator-side identity holding the encrypted
  per-node control credential;
- **agent runtime:** an unprivileged node identity that owns workspaces and coding-tool
  credentials but cannot read agentd state or control credentials.

There is no supported production same-UID fallback. Local source development may opt
in explicitly and emits a security warning; this mode provides no agent isolation.

### Remote Linux nodes

- Initial node enrollment installs a root-owned system service and protected state
  directory through an explicit administrative step.
- Agentd binds only to node loopback. The orchestrator reaches it through SSH
  `direct-tcpip`; no agentd port is externally published.
- Agentd reads a unique per-node credential from a root/service-owned file. Agent
  runtime users cannot read it.
- The orchestrator stores its copy in Shepherd's AES-256-GCM secret store.
- Agentd launches every session with an explicit unprivileged UID, GID, supplementary
  group set, HOME, working directory, environment allowlist, resource policy, and
  optional Landlock write confinement.
- No control credential or control socket descriptor is inherited by the child.
- SSH host identity must be confirmed during enrollment. Subsequent mismatch fails
  without automatic re-pinning.
- Enrollment and binary delivery travel over the pinned SSH connection through the
  constrained `flock-node-admin` helper. The existing authenticated daemon is queried
  before rollout; active sessions defer the upgrade. The candidate is architecture-
  selected, checksum-verified, atomically activated, and must pass the authenticated
  control handshake or the retained prior binary is restored.

### Local Docker node

- The container starts with enough privilege to launch agentd and then runs the web
  orchestrator under a dedicated control UID.
- Agent sessions run under a different unprivileged runtime UID.
- The control socket and credential are accessible to agentd/control only, not the
  runtime UID.
- Workspaces and coding-tool credentials are owned by the runtime UID and persist in
  dedicated volumes.
- The agent runtime receives no Docker socket access. Browser-container management is
  moved behind a separately constrained service or socket proxy.

### Control protocol

- Every node has a unique control credential; no installation-wide shared agentd
  secret is reused across nodes.
- Handshake authentication uses a nonce-based MAC challenge/response and binds node
  identity, protocol version, daemon version, and supported capabilities.
- Captured authentication messages are not replayable.
- Protocol or node-identity mismatch fails before status snapshots or session
  operations are accepted.
- Unix socket permissions are defense in depth, not a separate trust protocol. Every
  transport performs the nonce/MAC handshake; only explicit same-user development mode
  may use an empty credential.
- Credential rotation supports overlap for one bounded transition and is audited.
- Node-level authentication authorizes the orchestrator connection only. Public agent
  capabilities are a separate protocol and never authenticate to agentd.
- Go clients import the versioned `agentd/proto`, `agentd/controlauth`, and generated
  `agentd/compatibility` packages. Hand-copied wire contracts are unsupported.

## Alternatives considered

### Keep the same user and hide the secret in the environment

Rejected. Same-UID processes can access same-user files and may inspect process state;
the environment is not a security boundary.

### Keep the same user and add per-session agentd tokens

Rejected as the primary boundary. Per-session authorization is useful defense in
depth, but a same-UID agent could still target the node-control credential or daemon
state. OS identity separation remains required.

### Run a user service and rely only on loopback

Rejected. Loopback limits remote reachability but is available to every process on the
node. The current shared secret would remain readable by the same user.

### One daemon container per agent session

Deferred. It provides a strong boundary but imposes a container runtime on every
remote node and complicates host workspace and coding-tool credential access. The
system-service design provides the required boundary with less node overhead.

## Consequences

- Secure remote-node setup is no longer zero-install SSH bootstrap. It requires an
  explicit enrollment command or package with administrative approval.
- Agentd must implement privilege drop and carefully validate UID/GID/workspace input.
- The local orchestrator image needs separate users and a root entrypoint that drops
  privileges correctly.
- Self-update becomes a security-sensitive protocol requiring checksums, rollback, and
  release verification.
- Tests need disposable VMs/containers capable of exercising real UID boundaries and
  system service behavior.

## Required spike evidence

Before the production migration is accepted, a spike must prove:

1. agentd creates and resizes a PTY, launches a coding tool as the runtime UID, and
   preserves terminal ownership;
2. reconnect and scrollback work after the orchestrator disconnects;
3. an agent cannot read the control credential or connect successfully to agentd;
4. `/proc`, environment, file descriptors, group membership, and filesystem
   permissions do not expose control material;
5. daemon crash/restart and node reboot reconcile sessions predictably;
6. a failed binary upgrade rolls back to the previous healthy agentd;
7. local Docker and remote Linux nodes enforce equivalent boundaries.

## Revisit when

- non-Linux nodes become a committed target;
- rootless container isolation can replace the system-service boundary without
  weakening workspace and credential behavior; or
- the agent runtime moves entirely into per-session containers.
