# Changelog

Notable changes to Shepherd are documented here. The project follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before 1.0.

## [Unreleased]

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

- Reviewed two newly reported Perl findings inherited through Debian's Git dependency.
  Debian has not published fixed packages, so the findings remain in the visible,
  expiring image-risk register and must be reassessed at every release.

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

[Unreleased]: https://github.com/billiondollarsolo/shepherd/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.4.1
[0.4.0]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.4.0
[0.3.1]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.3.1
[0.3.0]: https://github.com/billiondollarsolo/shepherd/releases/tag/v0.3.0
