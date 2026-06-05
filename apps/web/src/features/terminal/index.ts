/**
 * Terminal feature (US-12): the xterm.js renderer + PTY WebSocket hook + framing.
 * Public surface for the rest of the app (e.g. the center tab group, US-33).
 *
 * Renderer is xterm.js (US-0a decision: wterm was spiked but reverted — wterm
 * v0.3.0 lacks the DEC Special Graphics charset that agent TUIs use to draw
 * boxes). xterm.js is GPU-accelerated (WebGL addon) with unicode11 + web-links
 * for a local-terminal-grade experience. See `Terminal.tsx`.
 */
export { default as Terminal } from './Terminal.js';
export type { TerminalProps, XtermFactory, XtermLike } from './Terminal.js';
export { usePtyWebSocket } from './usePtyWebSocket.js';
export type {
  UsePtyWebSocket,
  UsePtyWebSocketOptions,
  PtyConnectionState,
  WsLike,
  WsFactory,
} from './usePtyWebSocket.js';
export {
  ptyChannel,
  ptyWebSocketUrl,
  encodePtyInput,
  encodeResize,
  decodePtyFrame,
} from './ptyProtocol.js';
