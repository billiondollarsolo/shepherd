# Decision: Terminal rendering (xterm.js desktop, Ghostty Web mobile)

Status: Accepted, amended for mobile
Date: 2026-05-29; amended 2026-07-11

## Context

The cockpit streams remote agent terminals to the browser bidirectionally over
WebSocket. Phase-0 spike **US-0a (wterm-vs-xterm)** was scoped to compare
`@xterm/xterm` against alternatives (e.g. wterm) for rendering fidelity and
performance under high-throughput agent output.

## Decision

Desktop uses **xterm.js (`@xterm/xterm` + `@xterm/addon-fit`)**. Mobile uses
**Ghostty Web** for its canvas renderer and touch-oriented terminal lifecycle.
Both consume the same PTY WebSocket protocol; changing the renderer does not
change session ownership or transport semantics.

## Consequences

- `@xterm/xterm` is a declared dependency of `apps/web`.
- `ghostty-web` is loaded only by the mobile terminal chunk.
- Terminal streaming is bidirectional over WebSocket; the renderer is a client detail.
- Nodes stay dumb couriers — no node-side terminal logic.

## Revisit when

- Desktop Ghostty Web validation demonstrates a material improvement over xterm.js, or
- either renderer cannot preserve terminal fidelity for supported agent TUIs.
