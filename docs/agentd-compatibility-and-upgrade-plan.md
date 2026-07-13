# Agent daemon compatibility and long-term upgrade plan

## Objective

Make Shepherd upgrades predictable across the application stack and remote execution
nodes. A Shepherd release must be able to say whether a node daemon is compatible,
should be upgraded, or must be upgraded, without equating every binary-version
difference with incompatibility or interrupting active agents.

The policy separates four concerns that evolve at different rates:

1. **Shepherd release version** — the orchestrator, web application, browser worker,
   database migrations, and bundled daemon artifacts released together.
2. **Daemon binary version** — identifies a particular `flock-agentd` build.
3. **Control protocol version** — changes only when the wire contract is
   incompatible. Patch and feature releases should normally retain the protocol.
4. **Capabilities** — authenticated feature identifiers that permit additive
   evolution inside a protocol generation.

## User-facing states

| State               | Meaning                                                                                                                            | Automatic behavior                                                                     | Operator behavior                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Compatible          | Protocol and required capabilities are supported and the daemon is at or ahead of the preferred release                            | Keep running; never downgrade                                                          | No action required                                                                          |
| Upgrade recommended | The daemon is supported but older than the preferred release, or its managed service needs migration                               | Drain active sessions, then upgrade automatically; allow an explicit upgrade when idle | Schedule at convenience                                                                     |
| Upgrade required    | Version is below the supported floor, protocol is unsupported, required capabilities are absent, or identity cannot be established | Fail closed; never guess that sessions are safe to terminate                           | Drain/stop sessions through a compatible release or perform a confirmed maintenance upgrade |

Unknown or malformed version information is treated as **upgrade required**, not
as compatible.

## Support policy

- Every release declares one preferred daemon version, a minimum daemon version,
  supported protocol versions, and required control capabilities in a checked-in
  compatibility manifest.
- A supported daemon receives security fixes for at least one Shepherd minor-release
  line and at least 90 days after its replacement, whichever is longer. Before
  1.0, the project may intentionally reset this window in release notes when the
  protocol is still experimental.
- Protocol versions are not bumped for additive fields. Receivers continue to
  ignore unknown JSON fields and optional capabilities gate new operations.
- Supporting an older protocol means retaining and testing its codec and behavior;
  merely listing it in metadata is insufficient.
- A newer daemon that satisfies the running orchestrator's protocol and capability
  contract remains compatible. The orchestrator must never automatically replace
  it with an older binary.
- Security advisories may raise the minimum daemon version immediately. The release
  notes must identify this as a mandatory node upgrade and describe session-drain
  requirements.

## Phase 1 — Machine-readable compatibility policy

### Tasks

- Add `agentd/COMPATIBILITY.json` as the release-owned compatibility manifest.
- Validate its schema, semantic versions, ordered/unique protocol list, preferred
  protocol membership, and unique capabilities during startup and release checks.
- Ensure the minimum version never exceeds `agentd/VERSION`.
- Ship the manifest in the orchestrator image beside `agentd/VERSION`.
- Document the support-window fields as policy metadata, not runtime timers.

### Reasoning

Compatibility is release data. Keeping it explicit and reviewable prevents hidden
logic from drifting across the bootstrapper, API, UI, and release automation.

### Definition of done

- Invalid compatibility metadata fails startup and `pnpm release:check`.
- One canonical loader supplies the runtime policy.
- Container and source-tree execution resolve the same manifest.

## Phase 2 — Compatibility evaluator

### Tasks

- Implement strict SemVer parsing/comparison without accepting partial or ambiguous
  versions.
- Evaluate daemon version, negotiated protocol, authenticated capabilities, and
  managed-service state into a stable compatibility result.
- Return structured reason codes and human-readable guidance.
- Distinguish binary replacement from service-only migration.
- Never classify a newer compatible daemon as a downgrade candidate.

### Reasoning

Rollout behavior must be driven by a pure, exhaustively tested decision function,
not scattered string comparisons.

### Definition of done

- Versions below the floor are required upgrades.
- Older supported versions are recommended upgrades.
- Equal and newer compatible versions are accepted.
- Unsupported protocols, missing capabilities, and malformed versions require an
  upgrade.

## Phase 3 — Authenticated negotiation and capability enforcement

### Tasks

- Let the orchestrator attempt supported protocol versions in preference order.
- Keep Go consumers on the public `agentd/proto`, `agentd/controlauth`, and generated
  `agentd/compatibility` packages; copied wire structs are not supported.
- Continue binding the selected protocol, daemon version, and capabilities into the
  authenticated handshake.
- Expose the authenticated daemon identity from the client.
- Evaluate capabilities only after verifying the daemon MAC.
- Keep protocol failures redacted in public health APIs while preserving actionable
  compatibility reasons in the node readiness report.

### Reasoning

Unauthenticated version banners cannot make upgrade decisions. Compatibility is
trusted only after node identity, nonces, version, protocol, and capabilities are
cryptographically bound.

### Definition of done

- A supported protocol completes mutual authentication.
- An unsupported protocol cannot be mistaken for a network outage.
- Missing authenticated capabilities produce a mandatory-upgrade result.
- Existing protocol-v2 daemons remain connectable.

## Phase 4 — Session-safe rollout behavior

### Tasks

- Use compatibility results instead of exact version inequality in bootstrap and
  connection management.
- For a recommended or required replacement, query the authenticated old daemon
  before mutation and defer while sessions are active.
- If the old protocol cannot be authenticated, fail closed; do not infer that the
  node is idle.
- Keep mandatory-old sessions attachable during a deferred rollout, but reject new
  session creation so the node can drain instead of remaining unsupported forever.
- Retain candidate checksum validation, authenticated post-start health checks, and
  rollback to the previous known binary.
- Do not downgrade a newer compatible daemon.

### Reasoning

Availability and data preservation take precedence over rollout speed. “Cannot
count sessions” is not equivalent to “zero sessions.”

### Definition of done

- Active agents survive orchestrator upgrades.
- Idle, supported older daemons update automatically.
- Newer compatible daemons remain untouched.
- Failed candidates roll back and reconnect when the previous daemon is compatible.

## Phase 5 — API and user experience

### Tasks

- Add structured daemon compatibility data to node lifecycle and preflight
  contracts.
- Show state, installed/preferred/minimum versions, protocol support, and missing
  capabilities on the node details page.
- Present the upgrade action for recommended and required states, with stronger
  language for mandatory upgrades.
- Preserve explicit confirmation and backend enforcement that refuses known active
  sessions.

### Reasoning

Operators need to understand whether an update is maintenance or a hard prerequisite,
and why, without reading logs.

### Definition of done

- The UI does not call every version mismatch mandatory.
- A mandatory state gives a concrete reason.
- A compatible newer daemon does not show an upgrade/downgrade action.
- API contracts reject malformed compatibility data.

## Phase 6 — Overall release and upgrade discipline

### Tasks

- Make release validation check compatibility metadata alongside all package,
  daemon, Compose, browser-image, and changelog versions.
- Add a compatibility section to release notes whenever the minimum daemon or
  protocol range changes.
- Keep application images version-coupled and immutable.
- Use expand/migrate/contract database changes across the supported rollback
  window; destructive schema contraction must wait until the oldest supported
  application release is retired.
- Require a verified encrypted backup before stack upgrades and preserve the
  previous environment/image versions for recovery.
- Treat external coding-agent CLIs as detected integrations: report versions and
  capabilities, but do not claim compatibility without integration tests.

### Reasoning

Daemon compatibility alone is insufficient if database, image, and browser-worker
upgrades can drift or eliminate rollback.

### Definition of done

- Release CI fails on inconsistent or impossible compatibility metadata.
- Release documentation identifies mandatory node transitions.
- Stack upgrade and rollback procedures retain version-coupled artifacts and a
  verified recovery point.

## Testing and validation

### Unit tests

- SemVer precedence, prereleases, malformed input, below/equal/above minimum and
  preferred versions.
- Supported and unsupported protocols.
- Missing, duplicate, and additional capabilities.
- Compatible, recommended, required, and service-migration decisions.
- Protocol preference fallback and authenticated identity stability.

### Integration tests

- Current orchestrator with current daemon.
- Current orchestrator with the oldest supported daemon fixture.
- Active-session deferral followed by automatic post-drain rollout.
- Unsupported daemon fails closed without service mutation.
- Candidate authentication failure triggers rollback.
- Explicit upgrade refuses active sessions.
- Local node reports the same compatibility contract as remote nodes.

### UI tests

- Each compatibility badge and explanation.
- Upgrade action visibility for compatible, recommended, and required states.
- Newer compatible daemon has no downgrade action.
- Mobile node details remain readable and actionable.

### Release validation

- Typecheck, lint, formatting, unit/integration tests, Go tests/vet, production build,
  Playwright smoke tests, release check, architecture/dead-code/duplicate checks,
  Compose validation, and `git diff --check`.

## Completion criteria

This plan is complete when compatibility is determined from authenticated protocol,
capability, and SemVer policy; node upgrades preserve active sessions; newer
compatible daemons are never downgraded; the API and UI clearly distinguish
recommended from required upgrades; and release automation prevents unsupported
metadata from shipping.
