/**
 * Browser feature: Layer C screencast Browser pane + hook + framing (US-27) and
 * the input takeover/release control surface (US-28). Public surface for the
 * rest of the app (e.g. the center tab group, US-33).
 */
export { default as BrowserPane } from './BrowserPane.js';
export type { BrowserPaneProps } from './BrowserPane.js';
export { useScreencast } from './useScreencast.js';
export type {
  UseScreencast,
  UseScreencastOptions,
  ScreencastConnectionState,
  WsLike,
  WsFactory,
} from './useScreencast.js';
export {
  screencastChannel,
  screencastWebSocketUrl,
  decodeScreencastFrame,
  frameToDataUrl,
  encodeOpen,
  encodeClose,
} from './screencastProtocol.js';
export type {
  ScreencastFrameMessage,
  ScreencastFrameMessage as ScreencastFrame,
  ScreencastFrameMetadata,
} from './screencastProtocol.js';

/**
 * US-28 — Layer C input takeover/release (FR-B4): `useBrowserControl` drives the
 * single-controller lifecycle (consumed by `BrowserPane`), and `browserInput`
 * translates DOM pointer/keyboard events into the CDP-shaped input intents the
 * orchestrator forwards as CDP `Input.*` events.
 */
export {
  useBrowserControl,
  type BrowserControlTransport,
  type UseBrowserControl,
} from './useBrowserControl.js';
export {
  cdpButton,
  cdpModifiers,
  keyIntent,
  mapPointToViewport,
  mouseIntent,
  scrollIntent,
  type RenderedPoint,
  type ViewportMapping,
} from './browserInput.js';
