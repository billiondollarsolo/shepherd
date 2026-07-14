# Decision: Remote Preview instead of server-side browser driving

Status: Accepted; supersedes the 2026-05-29 CDP/container design
Date: 2026-07-14

## Context

The original design launched one Chrome container per session, streamed compressed
frames into the Shepherd UI, and held a Docker-socket capability in a lifecycle worker.
It produced a blurry, high-latency interaction model and made a host-control primitive
part of the normal application stack. It also duplicated a browser the user already has.

The primary user need is to open a development server running on the same node as an
agent, including WebSocket and hot-module-reload traffic, when that node is not directly
reachable from the user's device.

## Decision

Shepherd provides **Remote Preview**, not browser driving:

- The owner selects a session and one node-loopback port.
- The orchestrator proves that `127.0.0.1:<port>` is listening through that node's
  existing local/SSH transport.
- It issues a random hostname and expiring 256-bit capability on a dedicated preview
  DNS suffix.
- Caddy obtains on-demand TLS only after an internal ask endpoint confirms that exact
  hostname is active.
- The gateway proxies HTTP upgrades and WebSockets while stripping Shepherd cookies,
  authorization, forwarded identity, referrer, and upstream cookie mutation.
- Preview state and token digests live only in bounded process memory; termination,
  explicit revoke, expiry, or orchestrator restart removes access.

No Shepherd service mounts the Docker socket, launches Chrome, speaks CDP, or streams a
screencast. Browser automation remains the responsibility of the coding tool or a
user-installed node-side integration.

## Consequences

- The preview is crisp and native because the user's browser renders it directly.
- HMR and application WebSockets work across the existing node connection.
- Untrusted application content is isolated from the control plane by origin, `__Host-`
  cookies, exact origin checks, and credential stripping.
- Preview requires wildcard DNS for public deployments. Without it, preview is disabled
  while terminals, Git, and all other Shepherd features continue normally.
- This is intentionally not a general-purpose forward proxy: only a session owner's
  explicit loopback port is reachable.
