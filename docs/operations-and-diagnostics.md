# Operations and diagnostics

`GET /health` is shallow liveness. `GET /ready` is dependency-aware database
readiness. Neither returns credentials or detailed topology and both are suitable for
container probes.

The installation owner can open **Settings → Operations** or request:

- `GET /api/diagnostics` for the current model;
- `GET /api/diagnostics/bundle` for a downloadable JSON support bundle.

Both detailed routes require the authenticated owner cookie. The model separates
database, migration, agentd/node, Remote Preview, disk, push, and process state; it
also reports exact Shepherd/agentd and detected coding-agent versions, the named
deployment mode, browser transport, public base URL, trusted-proxy state, bounded
collection sizes, deployment warnings, retry/drop counters, and the last 200 structured
failures.

Diagnostic context is scalar, length-bounded, and redacted by key name, known runtime
secrets, bearer patterns, private-key material, and credential-bearing PostgreSQL URLs.
PTY input/output, cookies, environment dumps, hook/orchestration tokens, SSH private
keys, master keys, and preview content are never bundle inputs. Canary-secret tests
gate the redactor.

Background work uses the shared diagnostic sink for event persistence, status mirror
and rehydrate, SSH lifecycle, preview lifecycle, reconciliation, push configuration,
readiness, and shutdown-adjacent failures. Transient errors remain visible in bounded
history and counters without creating a permanent stale banner; the live health model
shows whether the dependency recovered.
