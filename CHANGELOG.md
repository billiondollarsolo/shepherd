# Changelog

Notable changes to Shepherd are documented here. The project follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before 1.0.

## [0.6.2] - 2026-07-18

### Removed

- Gemini CLI agent integration, completely, across the whole stack (shared
  contracts, orchestrator, web, agentd, docs, scripts). Gemini is superseded by
  the Antigravity CLI (`agy`); Shepherd now ships eight supported coding tools.

### Documentation

- Accuracy sweep of the living docs (README, agent-integration matrix,
  node-tooling, flock-agentd design, design tokens) for the current agent
  roster, structured transports, and as-built theme tokens.

## [0.6.1] - 2026-07-17

### Added

- Structured chat transports for Claude (persistent stream-json) and Codex
  (app-server): rich tool cards with diffs, real approve/deny cards, the agent's
  live slash menu, and per-turn status — all over the agent's own protocol. Chat-
  capable agents (claude/codex) launch chat-first by default, with an explicit
  Terminal/Chat mode choice at launch.
- In-composer permission-mode switch (Ask / Accept edits / Plan / Full access) for
  every agent that supports modes; changing it relaunches the agent in that mode.
- Dynamic model discovery for Codex (`model/list` over the app-server).
- Chat rendering: syntax highlighting (highlight.js, themed to the terminal's ANSI
  palette), per-message copy, inline-code pills, and full-width assistant prose.

### Changed

- UI restyle: cool-graphite dark ramp, periwinkle-indigo accent, rounder radii,
  solid sidebar selection, and a wider chat column.
- Sidebar: the global New menu is limited to the Paddock lens; the Agents lens uses
  a per-project New session button; the collapse control is grouped with the lens
  toggle. Removed the in-pane Terminal/Chat toggle (the transport is fixed at launch).

### Fixed

- agentd structured transports resolve the agent binary against the runtime user's
  bin dirs, so sessions launch on fresh nodes where the CLI lives in `~/.local/bin`.
- Pen-layout resize no longer self-conflicts ("Pens changed on another client"):
  layout saves are debounced and auto-recover from a stale revision.

## [0.5.3] - 2026-07-15

### Changed

- Replaced Shepherd-built Caddy and PostgreSQL wrapper images with digest-pinned
  official Traefik 3.7 and PostgreSQL 16 images.
- Reduced the release surface to the three Shepherd-owned application images. Release
  CI resolves amd64 and arm64 child manifests from the pinned upstream Traefik and
  PostgreSQL indexes, scans each exact digest, and never republishes them.
- Moved bundled routing, WebSocket forwarding, HTTPS redirects, security headers, and
  private-HTTP policy to reusable Traefik file-provider templates. The edge uses no
  Docker provider, Docker socket, dashboard, or anonymous telemetry.
- Public Remote Preview now uses one DNS-01 wildcard certificate through the official
  Cloudflare or Route53 provider. Control-plane-only deployments retain HTTP-01, and
  private Tailnet/LAN port-pool and external-proxy modes remain supported.
- Extracted the nginx SPA configuration for reuse by the production web image and local
  high-port development stack.

### Security

- Removed the public on-demand certificate authorization endpoint and reserved the
  Preview gateway's entire `/_shepherd/` namespace except its capability bootstrap.
- Added an upgrade guard that prevents a former localhost/raw-IP Caddy TLS installation
  from silently moving to an unusable edge; operators must select real DNS/TLS or the
  explicit private-HTTP topology.
- Kept PostgreSQL on major 16 for a no-data-migration patch release while consuming the
  latest reviewed upstream patch manifest. Floating database and edge `latest` tags are
  not used.

## [0.5.1] - 2026-07-15

### Added

- Added automatic, read-only inventory and explicit latest-channel install/upgrade
  actions for Claude Code, Codex, OpenCode, Gemini, Grok, Aider, Cursor Agent, and Amp.
- Added Node-details Docker detection with separate installation, root-equivalent agent
  access, and access-removal actions instead of silently changing the node.
- Added the node-preparation script to versioned deployment bundles and documented the
  supported-tool tiers, authentication ownership, migration path, and Docker boundary.
- Added the node host name above project context on agent views.

### Changed

- Remote-node preparation installs no tools by default, accepts repeatable
  `--install-agent` selections, and reserves `--install-agents` for an explicit all-eight
  installation. Provider credentials remain owned by each CLI on its node.
- Aider, Cursor Agent, and Amp are now identified as supported terminal integrations;
  Shepherd does not overstate structured chat or telemetry support for them.
- The internal Vagrant validation path now exercises the same allowlisted installers as
  production node preparation. Vagrant remains a developer test fixture, not a customer
  deployment requirement.

### Security

- Managed node mutations are schema-allowlisted, confirmation-gated, time/output bounded,
  serialized per node, blocked around conflicting active sessions, and audited with
  redacted success/failure outcomes.
- Docker agent access uses a persistent ACL for only the isolated runtime identity,
  preserves existing human Docker-group access, and explicitly warns that system Docker
  control is root-equivalent.
- Existing node helpers retain read-only capability detection; managed writes remain
  disabled until the current idempotent preparation script is run. The daemon protocol
  and minimum supported daemon version are unchanged.

## [0.5.0] - 2026-07-15

### Added

- Added the separately pinned `shepherd-node-runtime` image, which owns the bundled
  local daemon, coding-agent tools, workspaces, PTYs, bounded node commands, and
  loopback Preview tunnels independently of the control plane.
- Added authenticated `exec_v1` and `tcp_tunnel_v1` daemon capabilities with clean
  runtime identity, process-group cancellation, output and time bounds, numeric-loopback
  enforcement, backpressure, concurrency limits, idle timeout, and maximum lifetime.
- Added signed/checksummed deployment bundles, topology generation metadata, separate
  runtime image digests, and session-aware migration/upgrade tooling.

### Changed

- Local node status now follows the authenticated daemon link instead of being assumed
  connected. The UI reports runtime compatibility, handshake time, active sessions, and
  the exact operator-side maintenance command.
- Control-plane upgrades preserve a compatible runtime container and live local agents;
  release smoke proves the daemon and agent PID survive forced orchestrator replacement.
- Removed the legacy orchestrator-local transport and `node-pty` dependency. Local Git,
  diff, filesystem, workspace, hooks, metrics, and Preview operations cross agentd.

### Security

- The orchestrator no longer mounts the local runtime home or daemon state and no longer
  contains coding-agent executables. The runtime has no published port, database network,
  application secrets, or Docker socket and runs read-only with explicit capabilities.

## [0.4.1] - 2026-07-14

### Fixed

- Adapted generic SSH and agentd Preview tunnels to the socket methods expected by
  Node's HTTP client, preventing the orchestrator from crashing when proxying a remote
  development server.
- Allowed Ghostty Web to load its bundled WebAssembly data URL under the finite Content
  Security Policy used by bundled TLS, private Tailnet HTTP, and local deployments.
- Added regression coverage for generic Duplex Preview tunnels and every production
  Content Security Policy mode.

### Security

- Reviewed newly reported findings inherited through required Debian runtime
  dependencies. Debian has not published fixed stable packages, so the findings remain
  in the visible, expiring image-risk register and must be reassessed at every release.

## [0.4.0] - 2026-07-14

### Added

- Added project-owned **Ports & Preview**: bounded agentd listener discovery, durable
  service labels and auto-forward preferences, HTTP/HTTPS/WebSocket forwarding,
  responsive desktop/mobile controls, and one-time launch capabilities.
- Added two Preview backends: isolated random hostnames for TLS/DNS deployments and an
  explicitly private, fixed no-DNS port pool for trusted Tailnets/LANs.
- Added Deployment & Preview settings with a runtime kill switch, bounded TTL/policy,
  effective topology/limits, finite CSP configuration, utilization, and live listener
  validation.
- Added release-candidate smoke coverage for fresh owner setup, login, a real supervised
  preview server, capability exchange, proxying, revocation, and container readiness.
- Added named bundled-TLS, external-TLS, and private-HTTP deployment modes with modular
  Compose overrides, runtime validation, diagnostics, and visible transport posture.

### Changed

- Updated the Shepherd tagline to **Guide Your Flock Of Agents** across the
  application, README, tests, and brand validation contract.
- Removed the server-side Chrome/CDP/screencast runtime, browser worker, Docker-socket
  dependency, and associated dead contracts and UI.
- Hardened the production stack with a non-root Caddy runtime, read-only filesystems,
  internal-only data services, explicit listener health checks, current patched base
  packages, and four separately scanned Shepherd images.
- Moved the stateless orchestrator runtime to current Debian stable, removed the legacy
  tmux package and redundant PostgreSQL client install, and added an expiring image-risk
  register that fails releases on new or overdue High/Critical findings.

### Security

- Public production modes now require HTTPS, an out-of-band fresh-install setup token,
  host-only Secure session cookies, durable login throttling, and other-session
  revocation after a password change. Deliberate private HTTP requires an explicit
  acknowledgement, exact HTTP origins, restricted-network guidance, and a persistent UI
  warning.
- Preview uses 256-bit one-time launch capabilities, credential/header/cookie filtering,
  global exact-Origin enforcement for unsafe control mutations, bounded resources,
  service-worker denial, opener isolation, and immediate connection teardown on revoke,
  expiry, node removal, runtime disable, or shutdown.

## [0.3.1] - 2026-07-13

### Fixed

- Staged file-backed Docker Compose secrets into ephemeral, identity-specific runtime
  paths before dropping privileges. Fresh installs can now keep host secret files at
  `0600` without preventing the orchestrator or browser worker from starting.
- Made the release smoke test enforce the same restrictive secret permissions documented
  in the public quick start, preventing this class of packaging mismatch from recurring.

## [0.3.0] - 2026-07-13

### Added

- Full mobile Paddock with node/project/agent navigation, agent creation,
  settings, node details, project Git, and responsive dialogs.
- Canvas-backed Ghostty Web terminal on mobile, including touch scrollback,
  explicit keyboard controls, Shift+Tab mode switching, and monochrome terminal
  symbol rendering.
- Project Pens with persisted membership, drag-and-drop ordering, configurable
  one-to-four-agent layouts, and focused agent views.
- Node health pages with CPU, memory, storage, process, project, Git, and agent
  information.
- Authenticated daemon compatibility policy with distinct compatible, recommended,
  and mandatory upgrade states, session-safe rollout, and no automatic downgrades.
- Public, versioned Go packages for the agentd wire protocol, mutual authentication,
  and generated compatibility policy so external clients cannot drift silently.
- Dedicated project source-control workspace.
- Release container automation for GHCR with multi-platform images, SBOMs, and
  build provenance.

### Changed

- Renamed the user-visible product from Flock to **Shepherd**, with the tagline
  **Shepherd Your Agents**, across the application, PWA, documentation, repository,
  issue forms, and release presentation.
- Renamed the canonical GitHub repository to `billiondollarsolo/shepherd`; the previous
  repository URL redirects, while compatibility-sensitive `flock-*` commands, package
  names, node services, environment variables, storage, API fields, and the published
  Go module path remain unchanged. The first public container images use the canonical
  `shepherd-*` names.
- Reworked the product navigation around Paddock, nodes, projects, agents, and
  Pens; removed the obsolete fleet-scope model.
- Refined the dark theme, typography, wordmark, status presentation, and mobile
  visual-viewport behavior.
- Production Compose now defaults to versioned GHCR images.
- `flock-agentd` now uses the fetchable nested module path
  `github.com/billiondollarsolo/flock/agentd`; releases publish matching
  `agentd/v<version>` module tags.

### Security

- Strengthened authentication, WebSocket origin/ownership checks, SSH host-key
  pinning, encrypted secret storage, login throttling, and dependency audit
  gates during the pre-release hardening cycle.

[Unreleased]: https://github.com/billiondollarsolo/shepherd/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.5.3
[0.5.1]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.5.1
[0.5.0]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.5.0
[0.4.1]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.4.1
[0.4.0]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.4.0
[0.3.1]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.3.1
[0.3.0]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.3.0
