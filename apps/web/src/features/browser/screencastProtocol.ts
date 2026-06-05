/**
 * Client-side framing for the `screencast:<sessionId>` WebSocket channel (US-27,
 * FR-B3, spec §8.2).
 *
 * Pure, side-effect-free helpers shared by the screencast hook + Browser pane.
 * Kept DOM/socket-free so they unit-test under `pnpm test:unit` without jsdom or
 * a running orchestrator. Mirrors `terminal/ptyProtocol.ts` (framing/url helpers
 * here, socket lifecycle in the hook).
 *
 * No `zod` import: like `terminal/ptyProtocol.ts`, this module does plain runtime
 * validation. `zod` is not a dependency of `apps/web` (only `@flock/shared` is),
 * and the orchestrator-side `ScreencastFrameMessage` zod schema
 * (apps/orchestrator/src/browser/layerC/protocol.ts) is the producer-side source
 * of truth for the exact same wire shape; this file is its consumer-side decoder.
 *
 * Wire framing matches the orchestrator Layer C forwarder
 * (apps/orchestrator — browser/layerC/protocol.ts, US-27):
 *   - frame  → client: TEXT JSON `{channel:'screencast',type:'frame',sessionId,data,metadata}`
 *     where `data` is a base64 JPEG straight from CDP `Page.screencastFrame`.
 *   - open/close control → server: TEXT JSON `{op:'open'|'close',sessionId}` so the
 *     orchestrator starts the screencast ON TAB OPEN and stops it ON TAB SWITCH.
 */

/** CDP frame metadata describing the captured viewport (placement/scaling). */
export interface ScreencastFrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

/** The inbound per-frame payload (mirrors the orchestrator `ScreencastFrameMessage`). */
export interface ScreencastFrameMessage {
  channel: 'screencast';
  type: 'frame';
  sessionId: string;
  /** Base64-encoded JPEG image bytes. */
  data: string;
  metadata: ScreencastFrameMetadata;
}

/** WS channel name for a session's screencast stream, per spec §8.2. */
export function screencastChannel(sessionId: string): string {
  return `screencast:${sessionId}`;
}

/**
 * Build the WebSocket URL for a session's screencast stream.
 *
 * Mirrors `ptyWebSocketUrl`: uses `VITE_WS_URL` when set, else derives
 * `ws(s)://` from the page origin so a same-origin, TLS-terminated deploy
 * (NFR-SEC1) works with no configuration. Path is `/ws/screencast/<sessionId>`
 * to match the orchestrator route convention (`/ws/<channel>/<sessionId>`).
 */
export function screencastWebSocketUrl(
  sessionId: string,
  env: { VITE_WS_URL?: string } = (import.meta as unknown as { env?: { VITE_WS_URL?: string } }).env ?? {},
  origin: string = typeof window !== 'undefined'
    ? window.location.origin
    : 'http://localhost',
): string {
  const configured = (env.VITE_WS_URL ?? '').replace(/\/$/, '');
  const base =
    configured ||
    origin.replace(/^http(s?):/i, (_m, s: string) => `ws${s}:`).replace(/\/$/, '');
  return `${base}/ws/screencast/${encodeURIComponent(sessionId)}`;
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseMetadata(raw: unknown): ScreencastFrameMetadata | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const required: Array<keyof ScreencastFrameMetadata> = [
    'offsetTop',
    'pageScaleFactor',
    'deviceWidth',
    'deviceHeight',
    'scrollOffsetX',
    'scrollOffsetY',
  ];
  for (const k of required) {
    if (!isNumber(m[k])) return null;
  }
  if (m.timestamp !== undefined && !isNumber(m.timestamp)) return null;
  return {
    offsetTop: m.offsetTop as number,
    pageScaleFactor: m.pageScaleFactor as number,
    deviceWidth: m.deviceWidth as number,
    deviceHeight: m.deviceHeight as number,
    scrollOffsetX: m.scrollOffsetX as number,
    scrollOffsetY: m.scrollOffsetY as number,
    ...(m.timestamp !== undefined ? { timestamp: m.timestamp as number } : {}),
  };
}

/**
 * Parse an inbound screencast frame; returns `null` (rather than throwing) for
 * any non-frame / malformed message so the hook can ignore control echoes and
 * never crashes the render loop on an unexpected payload.
 */
export function decodeScreencastFrame(
  data: string,
): ScreencastFrameMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (o.channel !== 'screencast' || o.type !== 'frame') return null;
  if (typeof o.sessionId !== 'string' || o.sessionId.length === 0) return null;
  if (typeof o.data !== 'string' || o.data.length === 0) return null;
  const metadata = parseMetadata(o.metadata);
  if (metadata === null) return null;
  return {
    channel: 'screencast',
    type: 'frame',
    sessionId: o.sessionId,
    data: o.data,
    metadata,
  };
}

/** A renderable `data:` URL for an `<img>`/canvas from a decoded frame. */
export function frameToDataUrl(frame: ScreencastFrameMessage): string {
  return `data:image/jpeg;base64,${frame.data}`;
}

/**
 * Encode the "tab opened — start streaming on demand" control message (US-27).
 * The orchestrator issues `Page.startScreencast` when it receives this.
 */
export function encodeOpen(sessionId: string): string {
  return JSON.stringify({ op: 'open', sessionId });
}

/**
 * Encode the "tab switched away — stop streaming" control message (US-27). The
 * orchestrator issues `Page.stopScreencast` when it receives this. Sent on
 * unmount / tab switch in addition to closing the socket, so the orchestrator
 * stops promptly even if the socket lingers.
 */
export function encodeClose(sessionId: string): string {
  return JSON.stringify({ op: 'close', sessionId });
}
