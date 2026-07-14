# State Ownership and Durability

This document is the source of truth for where Shepherd state lives. A new field must
fit one row below, or update this inventory in the same change. Browser memory and
orchestrator maps are never substitutes for durable state.

## Durable installation data

| State                                                        | Owner and store                           | Schema/version                                 | Retention and reset                                                                                                           | Backup                                 |
| ------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Installation owner and login sessions                        | PostgreSQL `users`, `sessions_auth`       | Drizzle migrations; auth contracts             | Owner lasts for the installation. Login sessions expire or are revoked. Owner reset uses the operator CLI.                    | Yes                                    |
| Nodes, encrypted SSH credentials, projects, and agent policy | PostgreSQL `nodes`, `secrets`, `projects` | Drizzle migrations; shared Zod contracts       | Explicit operator deletion; foreign-key cascades remove children. Secret ciphertext requires the matching master-key version. | Yes, including the external master key |
| Agent session registry and history                           | PostgreSQL `agent_sessions`               | Drizzle migrations; shared session schema      | Retained as history until explicit deletion. Live status is reconciled after restart.                                         | Yes                                    |
| Events and audit log                                         | PostgreSQL `events`, `audit_log`          | Shared event/audit enums                       | Append-oriented operational history. Retention is an operator policy until an automated policy is introduced.                 | Yes                                    |
| Push subscriptions                                           | PostgreSQL `push_subscriptions`           | W3C subscription contract                      | Removed on unsubscribe, invalid endpoint cleanup, or owner deletion.                                                          | Yes                                    |
| Per-project Pens and terminal placement                      | PostgreSQL `project_pens`                 | `ProjectPensV1`, optimistic integer `revision` | One document per owner/project; project or owner deletion cascades. A stale writer receives `409 pens_conflict`.              | Yes                                    |
| Saved project web services                                   | PostgreSQL `project_services`             | Strict shared Project Port contracts           | Project deletion cascades; labels/protocol/auto-forward survive restart, but no active capability does.                       | Yes                                    |
| Preview runtime preferences                                  | PostgreSQL `preview_runtime_settings`     | Strict runtime settings contract               | Owner deletion cascades; deployment hard caps always override runtime TTL/policy.                                             | Yes                                    |

## Durable cross-device owner preferences

`user_preferences` contains one strict `UserPreferencesValueV1` JSON document and
an optimistic revision. It currently owns:

- node order;
- session order per project;
- named layout presets.

The API returns revision zero and a canonical default when no row exists. Updates
must include `baseRevision`; stale updates receive the current document in a
`409 preferences_conflict` envelope. The web client performs a three-way merge:
remote values win for fields unchanged locally, while local edits win for fields
changed since the last acknowledged document. A failed save remains visible and
retryable. Owner deletion cascades this row. PostgreSQL backup includes it.

Future JSON changes require a new literal `version` and an explicit migration.
Unknown fields are rejected; the application never guesses at a newer document.

## Device-local preferences

These values intentionally use `localStorage` because sharing them across a phone
and workstation would be surprising:

| Key                      | Value and validation                                              | Reset behavior                              |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| `flock.theme`            | `light`, `dark`, or `system`; any other value becomes the default | Browser storage clear or Appearance setting |
| `flock.sidebarCollapsed` | Exact scalar `1`; every other value is false                      | Browser storage clear or sidebar toggle     |
| `flock.gridLayout`       | Exact `grid`; every other value is `columns`                      | Browser storage clear or layout control     |
| `flock.assistivePanels`  | Exact scalar `1`; every other value is false                      | Browser storage clear or setting toggle     |
| `flock.rightPanelWidth`  | Finite number from 360 through 1200 pixels; otherwise 520         | Browser storage clear or panel resize       |

Storage access is optional: unavailable/private storage falls back to safe defaults
and must not prevent rendering. Former keys `flock.nodeOrder`,
`flock.sessionOrder`, and `flock.layoutPresets` are obsolete and ignored; there is
no compatibility read path.

## URL and navigation state

Node, project, agent, settings, and overview identity belongs in the route. The URL
is the shareable/back-button source of truth. Transient shell selection mirrors the
active route but is not restored as durable data. Command-palette queries, open
dialogs, focused tabs, zoom, file selection, form drafts, and confirmation state are
ephemeral UI state and reset on navigation or reload.

## Ephemeral runtime state

The following are rebuilt or reconciled and are deliberately excluded from backup:

- TanStack Query response caches and derived node/project/session maps;
- live status, hook translation state, PTY subscribers, scrollback subscriptions,
  WebSocket clients, listener-discovery snapshots, active Project Preview allocations,
  launch capability digests/cookies, and viewport/control ownership;
- SSH connections, tunnels, agentd clients, connection attempts, health probes,
  rate-limit buckets, and login-throttle entries;
- encryption-key material cached in process memory;
- reconciliation snapshots, agent sandbox availability, model telemetry, and
  orchestration rate counters.

After an orchestrator restart, PostgreSQL supplies identity and history while node
reconciliation and agentd rebuild live truth. A cache may improve latency, but it
must be safe to discard and must never be reported as durable.

## Review checklist

For every new state field, answer all of the following in review:

1. Who is authoritative: installation, owner, device, URL, or live subsystem?
2. Must it survive browser refresh, a second device, orchestrator restart, and
   backup/restore?
3. What runtime schema and version reject corrupt or newer data?
4. What is the retention/deletion cascade and reset path?
5. Can two clients write it, and if so what revision/conflict policy prevents lost
   updates?
6. How does the UI expose save failure and recovery?
