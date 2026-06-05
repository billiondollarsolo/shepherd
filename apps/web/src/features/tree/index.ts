/**
 * Tree feature (US-23/US-32): shared status primitives + the live `status`
 * WebSocket consumed by the paddock sidebar (features/paddock/Sidebar.tsx). The
 * old standalone `SessionTree` view was removed (unmounted; its permission-mode
 * badge + attention ordering live in the paddock sidebar now).
 */
export { default as StatusIndicator } from './StatusIndicator.js';
export type { StatusIndicatorProps } from './StatusIndicator.js';

export { useStatusWebSocket } from './useStatusWebSocket.js';
export type {
  UseStatusWebSocket,
  UseStatusWebSocketOptions,
  StatusConnectionState,
  StatusWsLike,
  StatusWsFactory,
} from './useStatusWebSocket.js';

export {
  sortSessionsByAttention,
  groupNeedsAttention,
  groupAttentionRank,
  sortGroupsByAttention,
} from './ordering.js';
export type { OrderableSession } from './ordering.js';

export {
  STATUS_CHANNEL,
  statusWebSocketUrl,
  encodeStatusSubscribe,
  parseStatusFrame,
} from './statusWsProtocol.js';
