/**
 * Client-side framing for the `status` WebSocket channel (US-23, spec §8.2).
 *
 * Pure, side-effect-free helpers shared by the status-WS hook + components. Kept
 * DOM/socket-free so they unit-test under `pnpm test:unit` without jsdom or a
 * running orchestrator.
 *
 * The `status` channel is the LIVE path (spec §6.6, NFR-PERF1): the orchestrator
 * fans out one `StatusUpdateMessage` per transition over a single multiplexed,
 * authed socket. We mirror the terminal feature's URL convention
 * (`apps/web/src/features/terminal/ptyProtocol.ts`): when `VITE_WS_URL` is set it
 * is used as the WS base; otherwise we derive `ws(s)://` from the page origin so
 * a same-origin, TLS-terminated deploy (NFR-SEC1) works with no configuration.
 */
import {
  StatusUpdateMessage,
  type StatusUpdateMessage as StatusUpdate,
} from '@flock/shared';

/** WS channel name for the live status fan-out, per spec §8.2 (`status`). */
export const STATUS_CHANNEL = 'status' as const;

/**
 * Build the WebSocket URL for the live status channel.
 *
 * The path is `/ws/status` to match the orchestrator status-WS route
 * (one socket per client, fanning out every session's transitions).
 *
 * @param env     injected for tests; defaults to Vite's import.meta.env
 * @param origin  injected for tests; defaults to window.location.origin
 */
export function statusWebSocketUrl(
  env: { VITE_WS_URL?: string } = (import.meta as unknown as { env?: { VITE_WS_URL?: string } })
    .env ?? {},
  origin: string = typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
): string {
  const configured = (env.VITE_WS_URL ?? '').replace(/\/$/, '');
  const base =
    configured ||
    origin.replace(/^http(s?):/i, (_m, s: string) => `ws${s}:`).replace(/\/$/, '');
  return `${base}/ws/${STATUS_CHANNEL}`;
}

/**
 * The client→server subscribe envelope for the status channel. The status
 * channel is not session-scoped, so no `sessionId` is sent (spec §8.2
 * ClientSubscribeMessage; `sessionId` is only required for pty/screencast).
 */
export function encodeStatusSubscribe(): string {
  return JSON.stringify({ op: 'subscribe', channel: STATUS_CHANNEL });
}

/**
 * Parse + validate an inbound status frame against the shared zod contract
 * (`StatusUpdateMessage`, spec §8.2). Returns the typed message, or `null` for
 * any frame that is not a well-formed status update (e.g. a node/pty control
 * frame on the same multiplexed socket, or malformed JSON) so callers can
 * silently ignore non-status traffic without throwing on the live path.
 */
export function parseStatusFrame(data: unknown): StatusUpdate | null {
  let raw: unknown = data;
  if (typeof data === 'string') {
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const result = StatusUpdateMessage.safeParse(raw);
  return result.success ? result.data : null;
}
