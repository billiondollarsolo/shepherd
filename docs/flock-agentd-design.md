# flock-agentd architecture

Status: **as built**

Protocol: **v2**

Supported node OS: **Linux (amd64 and arm64)**

`flock-agentd` is Shepherd's only PTY transport. It owns agent and shell processes,
terminal input/output, resize, bounded scrollback, status extraction, and persisted
layout state. The browser never connects to agentd directly; the orchestrator bridges
authenticated browser WebSockets to one multiplexed agentd control connection per
node.

## Trust boundary

Production uses three distinct roles:

- agentd starts as root so it can create a PTY and drop process credentials;
- the orchestrator runs as a non-root control identity that can read the protected
  node credential and connect to the control socket;
- every coding tool, shell, MCP server, and repository subprocess runs as a fixed
  unprivileged agent identity with cleared supplementary groups.

The node credential, daemon state, and control socket are outside the agent user's
home and permissions. Child environments force the runtime HOME/USER/LOGNAME/SHELL/
PATH and remove control credential variables. Production startup fails closed if the
daemon is not root, the runtime identity is missing/root, the credential file is
unprotected, or a TCP listener is not a literal loopback address.

Source development may explicitly use `--allow-insecure-same-user`. It emits a
security warning and provides no agent isolation. It is not a supported production
mode.

The accepted decision and threat boundary are recorded in
`docs/decisions/agentd-privilege-separation.md` and
`docs/decisions/security-threat-model.md`.

## Topology

```text
browser -- HTTPS/WSS --> orchestrator/control identity
                              |
                              +-- protected Unix socket --> local agentd (root)
                              |
                              +-- SSH direct-tcpip ------> remote agentd (root,
                                                           loopback listener)

agentd -- setuid/setgid + raw PTY --> flock-agent --> coding tool/repository code
```

Remote agentd ports are never published. SSH supplies transport encryption and pinned
host identity; the v2 agentd handshake supplies independent node authentication and
replay resistance. Local production uses a root/control-owned Unix socket (`0660`).

## Control authentication

Every node receives a different 256-bit control credential. The orchestrator copy is
AES-256-GCM encrypted in the `secrets` table and referenced internally from the node.
The local daemon copy lives in the root-owned agentd state volume; remote copies are
installed root-only over SFTP. Credentials are never returned in browser DTOs or
placed in URLs.

Protocol v2 uses mutual HMAC-SHA-256 challenge/response:

1. Client sends `hello` with protocol version, expected node identity, and a fresh
   256-bit client nonce.
2. Daemon rejects version/node mismatch, creates a fresh server nonce, and returns a
   challenge binding both nonces, node identity, daemon version, and the ordered
   capability list. A server-role MAC proves daemon credential possession.
3. The client verifies that MAC and returns a separately domain-separated client-role
   MAC over the same transcript.
4. Only after successful verification does agentd return `helloOk`, start status
   replay, or accept operations.

A captured authenticate frame cannot be replayed on another connection because the
new server nonce changes the transcript. Go and TypeScript share a fixed MAC test
vector, and a cross-language socket smoke verifies negotiation and PTY use.

Credential rotation runs over an already authenticated link. Agentd atomically
replaces the protected file without changing ownership/mode, keeps existing PTYs and
authenticated connections alive, and accepts the previous credential for a bounded
five-minute commit/reconnect window. The orchestrator updates the encrypted per-node
record only after daemon acknowledgement and rotates back if that database claim
fails. Rotation is an owner-authenticated audited node operation; no key value is
returned or logged.

The wire sources of truth are:

- `agentd/proto/proto.go`
- `agentd/controlauth/controlauth.go`
- `apps/orchestrator/src/nodes/agentd/protocol.ts`
- `apps/orchestrator/src/nodes/agentd/control-auth.ts`

## Framing and operations

One duplex stream multiplexes all sessions for a node. Every frame is:

```text
uint32 big-endian body length | uint8 type | payload
```

Control payloads are JSON. PTY payloads are binary and session-tagged. Frames are
hard-capped at 16 MiB, writes have deadlines, connection panics are contained, and an
invalid/oversized stream is closed.

Authenticated operations currently include:

- open, close, list, subscribe, and unsubscribe;
- PTY input, output, resize, exit, and scrollback replay;
- status and node metrics;
- persisted workspace layout get/set;
- PTY and structured ACP session modes.

The daemon owns runtime identity selection. UID/GID is never accepted from the client.

## Local production lifecycle

The orchestrator image starts as root only to prepare protected state and supervise
agentd. Its entrypoint:

1. creates stable root/control-owned credential and node-identity files;
2. starts agentd with a minimal environment;
3. runs database migrations;
4. starts the orchestrator as `flock-control`;
5. lets agentd launch every session as `flock-agent`.

Agent home/tool configuration and agentd control state use separate persistent
volumes. The agent identity is never added to the control or Docker-socket groups.

## Remote enrollment and upgrade

Remote enrollment is a root-owned system service. There is no user-service or `nohup`
fallback because either would collapse the control/runtime identity boundary.

The orchestrator:

1. detects Linux architecture;
2. selects the matching shipped binary;
3. calculates SHA-256 locally and verifies the uploaded bytes remotely;
4. retains the previous binary, then atomically installs the candidate root-owned;
5. uploads the per-node credential as file content (never shell text/argv);
6. installs a hardened systemd unit that drops sessions to `flock-agent`;
7. records version, checksum, architecture, and installation time;
8. restarts and checks service health, restoring the previous binary on failure.

Enrollment requires explicit passwordless access to only the administrative actions
used by the bootstrap. A denied `sudo -n` fails visibly; Shepherd never falls back to an
insecure same-user daemon.

## Persistence semantics

Agentd survives orchestrator and browser disconnects. A reconnected client lists
existing sessions, subscribes, receives bounded scrollback, and resumes live output.
Layout metadata persists on disk.

A daemon crash or node reboot cannot preserve live PTY processes. Shepherd preserves its
durable session registry/layout and reconciles the missing process state; it must not
claim a vanished agent is still running.

## Security validation

Required regression coverage includes:

- agent UID/GID/home/group and environment assertions;
- denial reading the credential and daemon-only state;
- denial connecting to the protected Unix socket;
- positive connection as the control identity;
- `/proc`, inherited descriptor, and environment review;
- wrong-node, wrong-version, wrong-MAC, replay, malformed, and oversized-frame tests;
- real Go-to-TypeScript protocol/PTY smoke;
- production image process/permission inspection;
- clean remote-VM enrollment, reboot, upgrade failure, and rollback exercises.

The final remote-VM lifecycle exercises are tracked in
`docs/elite-code-and-agent-security-plan.md` and remain release-gating evidence, not
an assumption.
