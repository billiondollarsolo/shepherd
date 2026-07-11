/**
 * `useScreencast` — opens the `screencast:<sessionId>` WebSocket for one session
 * ON DEMAND and bridges decoded frames to the Browser pane (US-27, FR-B3,
 * NFR-PERF3, spec §8.2).
 *
 * On-demand semantics (the heart of US-27), mirrored on the client:
 *   - ON MOUNT (the Browser tab is open): connect, and on open send the `open`
 *     directive so the orchestrator issues `Page.startScreencast`.
 *   - ON UNMOUNT (the tab is switched away): send the `close` directive so the
 *     orchestrator issues `Page.stopScreencast`, THEN close the socket — so a
 *     backgrounded session stops consuming bandwidth.
 *   - Switching `sessionId` tears down the old stream and starts the new one.
 *
 * The WebSocket constructor is injectable so the hook is unit-testable with a
 * fake socket (no real network). Defaults to the global `WebSocket`. Mirrors
 * `terminal/usePtyWebSocket.ts`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { reconnectDelay } from '../../lib/utils';
import { deferReconnect } from '../../lib/reconnectGate';
import {
  decodeScreencastFrame,
  encodeClose,
  encodeOpen,
  screencastWebSocketUrl,
  type ScreencastFrameMessage,
} from './screencastProtocol';

/** Minimal browser-WebSocket surface the hook depends on (eases faking in tests). */
export interface WsLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer | ArrayBufferView | string }) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

/** Connection lifecycle exposed to the UI (e.g. for a "connecting…" hint). */
export type ScreencastConnectionState = 'connecting' | 'open' | 'closed';

export interface UseScreencastOptions {
  /** Called for every inbound (decoded) screencast frame. */
  onFrame: (frame: ScreencastFrameMessage) => void;
  /** Called for non-frame control messages on the channel (e.g. `{type:'url'}`). */
  onControl?: (msg: Record<string, unknown>) => void;
  /** Injected WebSocket factory (defaults to global WebSocket). */
  wsFactory?: WsFactory;
  /** Auto-reconnect while the tab stays open. Default true. */
  reconnect?: boolean;
}

export interface UseScreencast {
  state: ScreencastConnectionState;
  /** Send a control/input frame over the SAME screencast socket (no-op if closed). */
  send: (data: string) => void;
}

const WS_OPEN = 1;
const MAX_BACKOFF_MS = 5_000;
const BASE_BACKOFF_MS = 250;

const defaultFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export function useScreencast(
  sessionId: string,
  { onFrame, onControl, wsFactory = defaultFactory, reconnect = true }: UseScreencastOptions,
): UseScreencast {
  const [state, setState] = useState<ScreencastConnectionState>('connecting');
  const wsRef = useRef<WsLike | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onControlRef = useRef(onControl);
  onControlRef.current = onControl;
  const factoryRef = useRef(wsFactory);
  factoryRef.current = wsFactory;
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let cancelRetry: (() => void) | undefined;

    const connect = (): void => {
      if (disposed) return;
      setState('connecting');
      const ws = factoryRef.current(screencastWebSocketUrl(sessionId));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = (): void => {
        attempts = 0;
        setState('open');
        // ON DEMAND: ask the orchestrator to START the screencast now (US-27).
        if (ws.readyState === WS_OPEN) ws.send(encodeOpen(sessionId));
      };
      ws.onmessage = (ev): void => {
        if (typeof ev.data !== 'string') return;
        const frame = decodeScreencastFrame(ev.data);
        if (frame) {
          onFrameRef.current(frame);
          return;
        }
        // Non-frame control (e.g. {type:'url'}) → surface to the pane.
        if (onControlRef.current) {
          try {
            onControlRef.current(JSON.parse(ev.data) as Record<string, unknown>);
          } catch {
            /* not JSON; ignore */
          }
        }
      };
      ws.onerror = (): void => {
        // `onclose` follows; reconnect handled there.
      };
      ws.onclose = (): void => {
        wsRef.current = null;
        setState('closed');
        if (disposed || !reconnectRef.current) return;
        const delay = reconnectDelay(attempts, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
        attempts += 1;
        cancelRetry?.();
        cancelRetry = deferReconnect(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      cancelRetry?.();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        // ON TAB SWITCH: tell the orchestrator to STOP the screencast (US-27)
        // before tearing the socket down, so it stops promptly.
        if (ws.readyState === WS_OPEN) {
          try {
            ws.send(encodeClose(sessionId));
          } catch {
            // socket already closing; the close below still stops the stream
          }
        }
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        ws.close();
      }
    };
  }, [sessionId]);

  // Stable sender so input takeover can ride the same socket (US-28). Reads the
  // live socket via the ref so it never goes stale across reconnects.
  const send = useCallback((data: string): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WS_OPEN) ws.send(data);
  }, []);

  return { state, send };
}
