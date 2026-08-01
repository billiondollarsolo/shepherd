# Compatibility policy

**Source of truth in code:** [`internal/compat`](../internal/compat/compat.go)  
**Agentd wire protocol:** [`flock/agentd/proto`](../../flock/agentd/proto/proto.go) (`ProtocolVersion`)  
**Last updated:** 2026-07-11

This document describes what `shep-tui` expects from **flock-agentd** (local mode)
and the **Flock orchestrator** (fleet mode), and how version mismatches surface.

---

## Local mode — flock-agentd

| Constraint | Value |
| --- | --- |
| Supported hello `protocolVersion` | From agentd compatibility policy; currently **2** |
| Transport | Unix domain socket (default) or TCP with shared secret |
| Framing | Length-prefixed frames: control `0x01`, PTY out `0x02`, PTY in `0x03` |

### Negotiation

On connect, shep-tui sends a `hello` control frame with its protocol version.
The daemon replies with `protocolVersion` and optional `daemonVersion`.

Use:

```go
compat.CheckAgentd(proto, daemonVersion)
```

- `proto < MinAgentdProtocol` → **hard error** (upgrade agentd).
- Empty `daemonVersion` is allowed (informational only today).

### Clear errors

Typical failure paths already used by CLI/TUI:

| Symptom | Hint |
| --- | --- |
| Socket missing | `shep-tui up` / start `flock-agentd serve` |
| Hello / auth fail | Check node ID and `FLOCK_AGENTD_SECRET_FILE` / profile `agentd_secret_file` |
| Protocol too old | Upgrade flock-agentd; see `CheckAgentd` message |

`shep-tui doctor` probes the active profile backend.

---

## Fleet mode — orchestrator

| Constraint | Value |
| --- | --- |
| API version | **Soft** — empty / unknown is accepted |
| Auth (interim) | Cookie jar `flock_session` (`FLOCK_TOKEN`, login, cookies.json) |
| Live status / PTY | WebSocket bridges under `/ws/…` |

### Soft check

```go
compat.CheckOrchestrator(apiVersion)
```

- Empty version → **ok** (older orchestrators omit a version header).
- Explicit markers `incompatible`, `0`, `0.0`, `0.0.0` → **error**.
- Unparseable strings → **ok** (do not block operators).

Callers may log soft failures and continue; fleet mode should still attempt REST/WS.

Production token auth (U1) will replace cookie-jar debt — see `docs/PRODUCT.md`.

---

## Capability flags

`backend.Caps` advertises features so UI/CLI can hide unsupported surfaces:

| Cap | Local | Fleet (current) |
| --- | --- | --- |
| Multi-node | no | yes |
| Git / files / handoff | best-effort local | yes when API present |
| Pens API | no | yes |
| Audit log API | no | not wired yet (`ListAudit` → `ErrNotSupported`) |
| Cost / compare | client-side from telemetry | client-side |

Missing APIs return `backend.ErrNotSupported` rather than panicking.

---

## Client-side models (no peer version)

These Phase 3 packages work offline on domain types:

- `internal/ui/compare` — run-N board
- `internal/ui/cost` — spend table from `Session.Telemetry`
- `internal/ui/audit` — browser + JSON fixture loader
- `internal/ui/profiles` — config profile list/switch helpers

---

## Upgrade guidance

1. Keep **shep-tui** and **flock-agentd** from the same monorepo release train when possible.
2. If agentd is older than protocol 1, upgrade agentd **before** the TUI.
3. Fleet: pin orchestrator URL per profile; use `shep-tui doctor` and `auth status` after upgrades.
4. Cross-compile snapshots: `make release-snapshot` → `dist/shep-tui_linux_{amd64,arm64}` + `VERSION`.

---

## Related

- [`KEYBINDS.md`](KEYBINDS.md) — detach chord and chrome binds  
- [`TUTORIAL.md`](TUTORIAL.md) — dual-pane local path  
- [`PRODUCT.md`](PRODUCT.md) §10 Phase 4 / T4.9  
