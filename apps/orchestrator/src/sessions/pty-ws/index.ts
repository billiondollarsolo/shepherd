/**
 * PTY ⇄ WebSocket bridge (US-11): the `pty:<sessionId>` channel that streams a
 * session's PTY output to clients and forwards input, with binary framing,
 * reconnect-resume, and concurrent multi-client attach (FR-S6).
 *
 * Composition:
 *   - {@link PtySession}          — one shared, multi-subscriber PTY attachment
 *                                   with a recent-output ring buffer for resume.
 *   - {@link PtySessionRegistry}  — sessionId → shared PtySession (FR-S6 reuse).
 *   - {@link PtyWsServer}         — `ws` glue: binary PTY frames + shared-zod
 *                                   control frames over `/ws/pty/:sessionId`.
 */
export * from './pty-session.js';
export * from './pty-session-registry.js';
export * from './pty-ws-server.js';
