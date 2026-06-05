/**
 * Client-side framing for the `pty:<sessionId>` WebSocket channel (US-11/US-12).
 *
 * Pure, side-effect-free helpers shared by the terminal hook + component. Kept
 * DOM/socket-free so they unit-test under `pnpm test:unit` without jsdom or a
 * running orchestrator.
 *
 * Wire framing matches the orchestrator PTY⇄WS bridge (apps/orchestrator —
 * sessions/pty-ws/bridge.ts, US-11):
 *   - terminal OUTPUT → client: BINARY frames (raw PTY bytes)
 *   - keystroke INPUT → server: BINARY frames (raw bytes)
 *   - resize          → server: TEXT JSON `{op:'resize',cols,rows}`
 *
 * The browser WebSocket delivers binary messages as `ArrayBuffer` (we set
 * `binaryType='arraybuffer'`); xterm.js renders `string` or `Uint8Array`, so
 * `decodePtyFrame` normalizes whatever the socket hands us into a `Uint8Array`.
 */

/** WS channel name for a session's PTY stream, per spec §8.2 (`pty:<sessionId>`). */
export function ptyChannel(sessionId: string): string {
  return `pty:${sessionId}`;
}

/**
 * Build the WebSocket URL for a session's PTY stream.
 *
 * Mirrors the REST client convention (`VITE_API_URL` in routes/api.ts): when
 * `VITE_WS_URL` is set it is used as the WS base (e.g. `wss://flock.example`);
 * otherwise we derive `ws(s)://` from the current page origin so a same-origin,
 * TLS-terminated deploy (NFR-SEC1) works with no configuration.
 *
 * The path is `/ws/pty/<sessionId>` to match the orchestrator bridge route
 * (apps/orchestrator — pty-ws-server.ts: `^/ws/pty/([^/?]+)`).
 *
 * @param sessionId  the single authoritative session id (spec §4.2)
 * @param env        injected for tests; defaults to Vite's import.meta.env
 * @param origin     injected for tests; defaults to window.location.origin
 */
export function ptyWebSocketUrl(
  sessionId: string,
  env: { VITE_WS_URL?: string } = (import.meta as unknown as { env?: { VITE_WS_URL?: string } }).env ?? {},
  origin: string = typeof window !== 'undefined'
    ? window.location.origin
    : 'http://localhost',
  /**
   * Optional initial terminal size. Carried as `?cols=&rows=` so the orchestrator
   * opens the PTY at the right size FROM THE START — a fresh shell then prints its
   * prompt at the correct width with no resize-reflow (no "prompt twice").
   */
  size?: { cols: number; rows: number },
): string {
  const configured = (env.VITE_WS_URL ?? '').replace(/\/$/, '');
  const base = configured || origin.replace(/^http(s?):/i, (_m, s: string) => `ws${s}:`).replace(/\/$/, '');
  const q =
    size && size.cols > 0 && size.rows > 0 ? `?cols=${size.cols}&rows=${size.rows}` : '';
  return `${base}/ws/pty/${encodeURIComponent(sessionId)}${q}`;
}

/**
 * Encode a resize control message exactly as the bridge expects: a TEXT JSON
 * frame `{op:'pty:resize',sessionId,cols,rows}`, matching the shared
 * `ClientPtyResizeMessage` contract the server validates with zod. (A previous
 * `{op:'resize'}` form was silently rejected by the server's ClientMessage
 * parse, so tmux never resized — the "terminal not filling the window" bug.)
 */
export function encodeResize(sessionId: string, cols: number, rows: number): string {
  return JSON.stringify({ op: 'pty:resize', sessionId, cols, rows });
}

const encoder = new TextEncoder();

/** Encode user keystrokes (xterm `onData`) to bytes for an upstream BINARY frame. */
export function encodePtyInput(input: string): Uint8Array {
  return encoder.encode(input);
}

/**
 * Normalize an inbound PTY frame to bytes for `term.write(Uint8Array)`.
 *
 * Handles the shapes a browser WebSocket `message.data` can carry with
 * `binaryType='arraybuffer'` (ArrayBuffer, typed-array views) plus the
 * already-decoded `string` form (re-encoded to UTF-8 bytes so callers always
 * get a single, uniform `Uint8Array` to hand xterm).
 */
export function decodePtyFrame(data: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // ArrayBufferView (Uint8Array, DataView, ...): view its underlying buffer slice.
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
