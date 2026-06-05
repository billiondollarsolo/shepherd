/**
 * `usePtyWebSocket` — opens (and keeps open) the `pty:<sessionId>` WebSocket for
 * one session and bridges it to a terminal (US-11/US-12, spec §8.2).
 *
 * Responsibilities:
 *   - connect to `ptyWebSocketUrl(sessionId)` with `binaryType='arraybuffer'`
 *   - deliver inbound PTY bytes to `onData(Uint8Array)` (decoded via decodePtyFrame)
 *   - expose `sendInput(string)` (binary keystrokes) and `sendResize(cols,rows)`
 *     (JSON envelope) matching the orchestrator bridge framing
 *   - auto-reconnect with capped backoff so "reconnect resumes" (US-11)
 *
 * The WebSocket constructor is injectable so the hook is unit-testable with a
 * fake socket (no real network). Defaults to the global `WebSocket`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  decodePtyFrame,
  encodePtyInput,
  encodeResize,
  ptyWebSocketUrl,
} from './ptyProtocol';

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

/**
 * Connection lifecycle exposed to the UI. `exited` is TERMINAL: the PTY's
 * process (agent/shell) ended + the tmux session is gone, so we do NOT reconnect.
 */
export type PtyConnectionState = 'connecting' | 'open' | 'closed' | 'exited';

export interface UsePtyWebSocketOptions {
  /** Called for every inbound PTY frame (already decoded to bytes). */
  onData: (bytes: Uint8Array) => void;
  /** Injected WebSocket factory (defaults to global WebSocket). */
  wsFactory?: WsFactory;
  /** Disable auto-reconnect (tests / teardown). Default true. */
  reconnect?: boolean;
  /**
   * Optional: the terminal's current size at (re)connect, carried in the WS URL
   * so the PTY opens at the right size up front (no startup resize-reflow).
   * Read fresh on every connect so a reconnect uses the latest size.
   */
  getInitialSize?: () => { cols: number; rows: number } | null;
  /**
   * Called when the socket OPENS again after a prior open (a RECONNECT, not the
   * first connect). The terminal kept its old content while we were away, so the
   * server's resume replay would be APPENDED (duplicate prompts/boxes); the
   * consumer resets its terminal here so the replay repaints cleanly instead.
   */
  onReconnect?: () => void;
}

export interface UsePtyWebSocket {
  state: PtyConnectionState;
  /** Send user keystrokes upstream as a binary frame. */
  sendInput: (input: string) => void;
  /** Send a resize control message (JSON envelope). */
  sendResize: (cols: number, rows: number) => void;
}

const WS_OPEN = 1;
const MAX_BACKOFF_MS = 5_000;
const BASE_BACKOFF_MS = 250;

const defaultFactory: WsFactory = (url) =>
  new WebSocket(url) as unknown as WsLike;

export function usePtyWebSocket(
  sessionId: string,
  {
    onData,
    wsFactory = defaultFactory,
    reconnect = true,
    getInitialSize,
    onReconnect,
  }: UsePtyWebSocketOptions,
): UsePtyWebSocket {
  const [state, setState] = useState<PtyConnectionState>('connecting');
  const wsRef = useRef<WsLike | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  // Keep latest values without re-running the connect effect.
  const factoryRef = useRef(wsFactory);
  factoryRef.current = wsFactory;
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;
  const initialSizeRef = useRef(getInitialSize);
  initialSizeRef.current = getInitialSize;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    let disposed = false;
    let exited = false; // PTY process ended (terminal) — never reconnect
    let attempts = 0;
    let hasOpened = false; // distinguishes the first open from a reconnect
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (disposed) return;
      setState('connecting');
      const size = initialSizeRef.current?.() ?? undefined;
      const ws = factoryRef.current(ptyWebSocketUrl(sessionId, undefined, undefined, size));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = (): void => {
        attempts = 0;
        // RECONNECT (not the first open): the terminal still shows the pre-drop
        // screen, so reset it before the server's resume replay arrives — else the
        // replay is appended (duplicate prompts / agent welcome boxes).
        if (hasOpened) {
          if (import.meta.env.DEV) console.debug(`[pty] RECONNECT ${sessionId}`);
          onReconnectRef.current?.();
        } else if (import.meta.env.DEV) {
          console.debug(`[pty] open ${sessionId}`);
        }
        hasOpened = true;
        setState('open');
      };
      ws.onmessage = (ev): void => {
        // The bridge multiplexes two frame kinds on this socket:
        //   - BINARY (ArrayBuffer/view) = raw PTY bytes → write to the terminal;
        //   - TEXT (string) = JSON control acks ({op:'attached'|'resize'|...}) →
        //     NOT terminal output. Writing those to xterm printed the raw JSON.
        if (typeof ev.data === 'string') {
          // Watch for the terminal `exited` control so we stop reconnecting.
          try {
            const ctrl = JSON.parse(ev.data) as { op?: string };
            if (ctrl?.op === 'exited') {
              exited = true;
              setState('exited');
            }
          } catch {
            /* not JSON; ignore */
          }
          return;
        }
        onDataRef.current(decodePtyFrame(ev.data));
      };
      ws.onerror = (): void => {
        // `onclose` follows; reconnect handled there.
      };
      ws.onclose = (ev?: unknown): void => {
        if (import.meta.env.DEV) {
          const c = ev as { code?: number; reason?: string; wasClean?: boolean } | undefined;
          console.debug(
            `[pty] CLOSE ${sessionId} code=${c?.code} reason=${c?.reason || '∅'} clean=${c?.wasClean}`,
          );
        }
        wsRef.current = null;
        if (exited) {
          setState('exited'); // terminal — leave it, do not reconnect
          return;
        }
        setState('closed');
        if (disposed || !reconnectRef.current) return;
        // The FIRST reconnect after a drop is near-instant (0–150ms): the common
        // case is a transient blip / "came back to the tab", and the orchestrator
        // keeps the daemon attach warm for minutes, so resume is immediate. The
        // small random spread still avoids a lockstep stampede when a whole grid
        // reconnects at once (e.g. orchestrator restart). Repeated failures fall
        // back to capped exponential backoff with ±20% jitter (T22).
        let delay: number;
        if (attempts === 0) {
          delay = Math.round(Math.random() * 150);
        } else {
          const base = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
          delay = Math.round(base * (0.8 + Math.random() * 0.4));
        }
        attempts += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (!ws) return;
      ws.onclose = ws.onerror = ws.onmessage = null;
      // Closing a socket that's still CONNECTING logs a noisy browser warning
      // ("WebSocket is closed before the connection is established") — common
      // under React StrictMode's mount→unmount→remount. If it hasn't opened yet,
      // defer the close to its open handler so it tears down cleanly.
      const CONNECTING = 0;
      if (ws.readyState === CONNECTING) {
        ws.onopen = (): void => ws.close();
      } else {
        ws.onopen = null;
        ws.close();
      }
    };
  }, [sessionId]);

  const sendInput = useCallback((input: string): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(encodePtyInput(input));
    }
  }, []);

  const sendResize = useCallback(
    (cols: number, rows: number): void => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WS_OPEN) {
        ws.send(encodeResize(sessionId, cols, rows));
      }
    },
    [sessionId],
  );

  return { state, sendInput, sendResize };
}
