# Changelog

Notable changes to Flock are documented here. The project follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before 1.0.

## [0.3.0] - 2026-07-11

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

[0.3.0]: https://github.com/billiondollarsolo/flock/releases/tag/v0.3.0
