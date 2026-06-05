# Decision: Terminal rendering (xterm.js)

Status: Accepted (Phase-0 spike US-0a deferred)
Date: 2026-05-29

## Context

The cockpit streams remote agent terminals to the browser bidirectionally over
WebSocket. Phase-0 spike **US-0a (wterm-vs-xterm)** was scoped to compare
`@xterm/xterm` against alternatives (e.g. wterm) for rendering fidelity and
performance under high-throughput agent output.

## Decision

Per the spec, **spikes US-0a/US-0b are optional and can be deferred; the v1
defaults are safe.** v1 uses **xterm.js (`@xterm/xterm` + `@xterm/addon-fit`)**
as the default terminal renderer. The orchestrator side uses `node-pty`/`tmux`.

This decision stands unless a future US-0a spike produces evidence that an
alternative is clearly better.

## Consequences

- `@xterm/xterm` is a declared dependency of `apps/web`.
- Terminal streaming is bidirectional over WebSocket; xterm in the browser,
  node-pty/tmux on the orchestrator.
- Nodes stay dumb couriers — no node-side terminal logic.

## Revisit when

- Output throughput causes visible jank, or
- A US-0a spike is run and clears an alternative.
