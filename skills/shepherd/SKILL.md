---
name: shepherd
description: "Control Shepherd-managed coding agent sessions via the orchestrator HTTP automation API. Use only when running inside a Shepherd session (SHEPHERD_ENV=1 or FLOCK_SESSION_ID is set) and the user asks to list, create, prompt, wait, read, or send keys to sibling agents in the same project. Do not use agentd control credentials. Do not use merely because a task could benefit from parallel agents."
---

# Shepherd

Shepherd runs coding agents on nodes under an orchestrator. In-session agents can coordinate **project siblings** through the automation HTTP API (not raw agentd).

## Prerequisites (gate)

Before any automation call, verify you are inside a Shepherd-managed session:

```bash
test "${SHEPHERD_ENV:-}" = 1 || test -n "${FLOCK_SESSION_ID:-}"
```

If the check fails, say you are not running inside Shepherd and stop.

Required context (injected by the orchestrator when automation is enabled):

| Variable | Purpose |
| -------- | ------- |
| `SHEPHERD_ENV=1` and/or `FLOCK_SESSION_ID` | Prove managed session |
| `FLOCK_PROJECT_ID` (or equivalent) | Project scope for sibling ops |
| `FLOCK_ORCHESTRATE_TOKEN` / automation token | Project-scoped API credential |
| API base | Origin of `FLOCK_HOOK_URL`, or `SHEPHERD_API_BASE` |

**Never** use agentd control credentials (`FLOCK_AGENTD_SECRET`, `FLOCK_AGENTD_CREDENTIAL`, `AGENTD_CONTROL_SECRET`, `FLOCK_MASTER_KEY`, `FLOCK_NODE_CREDENTIAL`, SSH private keys, or master keys). Those must not appear in the agent environment. Talk only to the orchestrator HTTP API with the session automation token.

## Policy locks

### D12 — Automation token scope

- Token may **list / create / prompt / wait / read / keys** only within the **same project** as the calling session.
- Cross-project targets are denied.
- **Admin**, node management, and whole-fleet ops are denied for automation tokens.
- Whole-node automation tokens are rejected by design.

### D14 — When this skill is safe to install

Ship/install this skill only after session **detection/status is trusted** (H1 path green) and security review of the automation surface. Wrong status + automation is worse than no automation. Feature-flag skill install defaults **off** until then.

## Auth

Prefer:

```http
X-Automation-Token: <token>
```

or `Authorization: Bearer <token>` on orchestrator routes that accept automation scope. Cookie session auth is for human operators in the browser, not for agent skill flows.

## HTTP commands

Base: `$SHEPHERD_API_BASE` (example `https://shepherd.example` or the hook URL origin).

### List sessions (same project)

```bash
curl -sS -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  "$SHEPHERD_API_BASE/api/sessions?projectId=$FLOCK_PROJECT_ID"
```

### Create session (same project)

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  -d "{\"projectId\":\"$FLOCK_PROJECT_ID\",\"agentType\":\"codex\"}" \
  "$SHEPHERD_API_BASE/api/sessions"
```

### Prompt

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  -d '{"text":"Review the current diff and report only actionable findings."}' \
  "$SHEPHERD_API_BASE/api/sessions/<session-id>/prompt"
```

### Wait (status)

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  -d '{"until":["idle","done","awaiting_input"],"timeoutMs":120000}' \
  "$SHEPHERD_API_BASE/api/sessions/<session-id>/wait"
```

Default settled targets align with idle / done / awaiting_input (needs-you). Cap timeouts (server max is typically 10 minutes).

### Status explain (read / debug)

```bash
curl -sS -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  "$SHEPHERD_API_BASE/api/sessions/<session-id>/status-explain"
```

Use explain when a wait fails or status looks wrong — do not invent lifecycle state.

### Send keys

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  -d '{"keys":["esc"]}' \
  "$SHEPHERD_API_BASE/api/sessions/<session-id>/keys"
```

Logical keys include `esc`, `enter`, `ctrl+c`, arrows, etc. Prefer agent prompt for normal text work.

### Read screen / output

When available:

```bash
# e.g. screen or events — prefer product APIs over scraping
curl -sS -H "X-Automation-Token: $FLOCK_ORCHESTRATE_TOKEN" \
  "$SHEPHERD_API_BASE/api/sessions/<session-id>/events"
```

## Coordination rules

- Default to **siblings in the current project** and the current working tree. Do not create projects, nodes, or cross-project sessions unless the user explicitly asks.
- Parse session IDs from JSON responses; do not invent UUIDs.
- After prompt, wait for a settled status before assuming completion. On `awaiting_input` / blocked, read explain + recent output before sending keys or a follow-up prompt.
- Do not terminate sessions you did not create unless the user explicitly asked.
- On `403` / `automation_denied`, stop — the token is project-scoped (D12).
- On `501` / `automation_*_not_implemented`, report that the orchestrator build lacks that op; do not fall back to agentd control secrets.

## Safety

1. Confirm `SHEPHERD_ENV=1` or `FLOCK_SESSION_ID`.
2. Use only the project automation token — never agentd control credentials.
3. Stay within the same `projectId` (D12).
4. Prefer prompt → wait → explain/read over raw keys.
5. Respect D14: if status detection is unreliable, do not automate destructive follow-ups.
