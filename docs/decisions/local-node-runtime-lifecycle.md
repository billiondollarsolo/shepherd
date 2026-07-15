# ADR: Isolate the bundled local node runtime

- **Status:** Accepted
- **Date:** 2026-07-15
- **Topology generation:** 2

## Decision

`node-runtime` owns all live work on Shepherd's bundled local node: `flock-agentd`,
agent processes, PTYs, scrollback, coding-agent CLIs, the runtime home, node-local
development servers, and node-local command execution. The orchestrator is a replaceable
control plane. It reaches the runtime only through the mutually authenticated Unix-socket
protocol and never mounts the runtime home or daemon state.

The daemon exposes a long-lived control/PTY connection, a fresh authenticated `exec_v1`
connection for each bounded command, and a fresh authenticated `tcp_tunnel_v1`
connection for each numeric-loopback tunnel. Command and PTY transport capabilities are
separate. SSH implements both; the local command transport does not fake a raw PTY.

The control credential and stable node ID live in a shared control volume readable by
the non-root orchestrator control group. Credential rotation is atomic. Neither service
receives the Docker socket. Runtime and control-plane image pins are independent.

The runtime drops every Linux capability, then restores only `CHOWN`, `DAC_OVERRIDE`,
`FOWNER`, `KILL`, `SETGID`, and `SETUID`. `FOWNER` is required because the root daemon
must enforce private modes on runtime-user-owned agent configuration and per-session
temporary directories; clean-volume and live-session tests fail without it. The
container otherwise has a read-only root filesystem, no published ports, and only its
runtime/control volumes and isolated runtime network.

## Failure guarantees

| Failure                       | Guaranteed behavior                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser/network loss          | Daemon process and PTY continue; attach replays bounded scrollback.                                                                              |
| Orchestrator loss/replacement | Runtime container, daemon PID, session IDs, and agent PIDs remain unchanged; the new control plane reauthenticates and reconciles.               |
| Runtime container/daemon loss | Local processes end and the node becomes unavailable honestly; database-only “running” state is forbidden.                                       |
| Host reboot                   | Docker restarts the runtime, but live processes do not survive a host reboot. Session metadata is reconciled.                                    |
| PostgreSQL loss               | Live daemon processes can continue temporarily, but management identity/history is unavailable. Restore database and master key, then reconcile. |
| Daemon restart                | Reconstructing live PTYs after daemon death is not promised here and remains separate work.                                                      |

## Upgrade consequence

Ordinary control-plane upgrades leave a compatible runtime untouched. Runtime changes
inventory exact active session IDs, defer recommended maintenance, and refuse required
maintenance unless work is drained or the operator supplies
`--force-stop-local-sessions`. Generation 1 to 2 has the same drain requirement because
the old daemon is a child of the old orchestrator.

## Rejected alternatives

- Supervising the daemon inside every orchestrator image couples unrelated lifecycles.
- Mounting the runtime workspace into both containers weakens ownership and isolation.
- Running local Git/filesystem/Preview calls in orchestrator reaches the wrong namespace.
- Giving the UI a Docker socket creates a root-equivalent remote-control surface.
