/**
 * `useStatusWebSocket` — subscribes to the live `status` channel (US-23, spec
 * §8.2) and maintains an in-memory `Map<sessionId, Status>` the tree renders.
 *
 * This is the browser end of the live status path. The orchestrator holds the
 * authoritative in-memory status map and fans out one `StatusUpdateMessage` per
 * transition; Postgres is never on this path (spec §6.6, NFR-PERF1). The hook:
 *   - connects to `statusWebSocketUrl()`
 *   - sends a `subscribe` envelope for the `status` channel on open
 *   - validates each inbound frame with the shared zod contract and applies it
 *     to a React-state Map, ignoring non-status traffic on the shared socket
 *   - auto-reconnects with capped backoff so a dropped link self-heals
 *
 * The WebSocket constructor is injectable (`WsFactory`) so the hook is
 * unit-testable with a fake socket — the exact convention established by the
 * terminal feature's `usePtyWebSocket`.
 */
import { useEffect, useRef, useState } from 'react';
import type { Status, StatusUpdateMessage } from '@flock/shared';
import { reconnectDelay } from '../../lib/utils';
import {
  encodeStatusSubscribe,
  parseStatusFrame,
  statusWebSocketUrl,
} from './statusWsProtocol';

/** Minimal browser-WebSocket surface the hook depends on (eases faking in tests). */
export interface StatusWsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type StatusWsFactory = (url: string) => StatusWsLike;

/** Connection lifecycle exposed to the UI (e.g. a "reconnecting…" hint). */
export type StatusConnectionState = 'connecting' | 'open' | 'closed';

export interface UseStatusWebSocketOptions {
  /** Injected WebSocket factory (defaults to global WebSocket). */
  wsFactory?: StatusWsFactory;
  /** Disable auto-reconnect (tests / teardown). Default true. */
  reconnect?: boolean;
  /**
   * Called for every parsed status frame (incl. its live `meta` telemetry). Lets
   * a consumer feed the TanStack Query cache from the WS — the polling→WS path —
   * without this hook depending on the query client. Read via a ref, so changing
   * the callback never re-opens the socket.
   */
  onUpdate?: (msg: StatusUpdateMessage) => void;
}

export interface UseStatusWebSocket {
  /** Connection lifecycle for an optional staleness hint. */
  state: StatusConnectionState;
  /** Live per-session status, keyed by the authoritative session id (spec §4.2). */
  statuses: ReadonlyMap<string, Status>;
  /** ms epoch of last semantic status change (from frame lastStatusTransitionAt / ts). */
  lastStatusTransitionAt: ReadonlyMap<string, number>;
}

const WS_OPEN = 1;
const MAX_BACKOFF_MS = 5_000;
const BASE_BACKOFF_MS = 250;

const defaultFactory: StatusWsFactory = (url) => new WebSocket(url) as unknown as StatusWsLike;

/**
 * Subscribe to the live status channel and expose the per-session status map.
 *
 * The map is replaced (not mutated) on each update so React re-renders; this is
 * the live path, so updates are O(1) and never touch the network for reads.
 */
export function useStatusWebSocket({
  wsFactory = defaultFactory,
  reconnect = true,
  onUpdate,
}: UseStatusWebSocketOptions = {}): UseStatusWebSocket {
  const [state, setState] = useState<StatusConnectionState>('connecting');
  const [statuses, setStatuses] = useState<ReadonlyMap<string, Status>>(() => new Map());
  const [lastStatusTransitionAt, setLastStatusTransitionAt] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  // Keep latest values without re-running the connect effect.
  const factoryRef = useRef(wsFactory);
  factoryRef.current = wsFactory;
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: StatusWsLike | null = null;

    const connect = (): void => {
      if (disposed) return;
      setState('connecting');
      ws = factoryRef.current(statusWebSocketUrl());

      ws.onopen = (): void => {
        attempts = 0;
        setState('open');
        if (ws && ws.readyState === WS_OPEN) {
          ws.send(encodeStatusSubscribe());
        }
      };
      ws.onmessage = (ev): void => {
        const msg = parseStatusFrame(ev.data);
        if (!msg) return; // ignore non-status traffic on the shared socket
        setStatuses((prev) => {
          const next = new Map(prev);
          next.set(msg.sessionId, msg.status);
          return next;
        });
        const iso = msg.lastStatusTransitionAt ?? msg.ts;
        const ms = Date.parse(iso);
        if (!Number.isNaN(ms)) {
          setLastStatusTransitionAt((prev) => {
            const next = new Map(prev);
            next.set(msg.sessionId, ms);
            return next;
          });
        }
        // Hand the full frame (incl. live `meta` telemetry) to the consumer so it
        // can feed the query cache — the polling→WS path.
        onUpdateRef.current?.(msg);
      };
      ws.onerror = (): void => {
        // `onclose` follows; reconnect handled there.
      };
      ws.onclose = (): void => {
        ws = null;
        setState('closed');
        if (disposed || !reconnectRef.current) return;
        const delay = reconnectDelay(attempts, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
        attempts += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (!ws) return;
      ws.onclose = ws.onerror = ws.onmessage = null;
      // Closing a socket that's still CONNECTING logs a noisy browser warning
      // ("WebSocket is closed before the connection is established") — common under
      // React StrictMode's mount→unmount→remount. If it hasn't opened yet, defer
      // the close to its open handler so it tears down cleanly. (Mirrors usePtyWebSocket.)
      const CONNECTING = 0;
      if (ws.readyState === CONNECTING) {
        ws.onopen = (): void => ws?.close();
      } else {
        ws.onopen = null;
        ws.close();
      }
    };
  }, []);

  return { state, statuses, lastStatusTransitionAt };
}
