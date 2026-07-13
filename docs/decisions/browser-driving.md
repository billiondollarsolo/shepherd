# Decision: Browser driving (native CDP / MCP, per-session isolation)

Status: Accepted (Phase-0 spike US-0b deferred)
Date: 2026-05-29

## Context

Some agents need a real browser. Shepherd provides a **per-session isolated
browser** (one container per session) running on the **orchestrator VPS** (not
the node), reverse-tunneled to the node-side agent on **loopback only**. Phase-0
spike **US-0b (browser-harness)** was scoped to evaluate the browser-driving
harness approach.

## Decision

Per the spec, **spikes US-0a/US-0b are optional and can be deferred; the v1
defaults are safe.** v1 drives the browser via **native CDP
(`chrome-remote-interface`) / MCP**, with **one chromium container per session**
managed by a dedicated browser worker (`dockerode`). The orchestrator calls only a
token-authenticated UUID-scoped launch/stop/reap API; the worker is the sole raw
Docker-socket holder and fixes image, network, command, labels, and resource limits.
The system chromium ships in the dev
image (`CHROME_BIN=/usr/bin/chromium`).

## Consequences

- `chrome-remote-interface` and `dockerode` are declared dependencies of the shared
  orchestrator image, but only the worker entrypoint joins the Docker socket group.
- Per-session browser isolation: one container per session, on the orchestrator
  VPS, exposed to the node-side agent over a loopback-bound reverse tunnel.
- The browser CDP endpoint is threaded by the single authoritative `session_id`
  (see `packages/shared` `SessionSchema` + `session-invariant.test.ts`).

## Revisit when

- A US-0b spike is run and clears a different harness, or
- Per-session container overhead becomes a bottleneck.
