import type { StatusUpdateMessage } from '@flock/shared';
import type { StatusMap, Unsubscribe } from './map.js';

/**
 * US-14 — the `status` WebSocket channel (spec §8.2).
 *
 * A thin adapter that subscribes to the in-memory {@link StatusMap} and pushes
 * each transition as a JSON `status` frame to every socket currently joined to
 * the channel. It owns NO source of truth and holds NO DB handle: the WS path
 * literally cannot touch Postgres (NFR-PERF1, spec §6.6).
 *
 * The full multiplexed socket (pty/screencast/nodes) is wired by later agents;
 * this class is responsible only for the `status` channel membership + fan-out.
 */

/**
 * The minimal surface this channel needs from a connected socket. Satisfied by
 * the `ws` library's `WebSocket` (which has `readyState` and `send`), but kept
 * structural so it is trivially fakeable in unit tests.
 */
export interface StatusSocket {
  /** `ws.OPEN === 1`; we only send to OPEN sockets. */
  readonly readyState: number;
  send(data: string): void;
}

/** `ws` numeric readyState for an open connection. */
const WS_OPEN = 1;

export class StatusChannel {
  private readonly sockets = new Set<StatusSocket>();
  private readonly unsubscribe: Unsubscribe;

  constructor(map: StatusMap) {
    // Subscribe once; fan out to all joined sockets on every transition.
    this.unsubscribe = map.subscribe((msg) => this.broadcast(msg));
  }

  /** Join a socket to the `status` channel. */
  add(socket: StatusSocket): void {
    this.sockets.add(socket);
  }

  /** Remove a socket (on unsubscribe or disconnect). */
  remove(socket: StatusSocket): void {
    this.sockets.delete(socket);
  }

  /** Number of sockets currently joined (for diagnostics/tests). */
  get size(): number {
    return this.sockets.size;
  }

  /** Detach from the map; no further frames are produced. */
  close(): void {
    this.unsubscribe();
    this.sockets.clear();
  }

  private broadcast(msg: StatusUpdateMessage): void {
    const frame = JSON.stringify(msg);
    for (const socket of this.sockets) {
      if (socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(frame);
      } catch {
        // A single broken socket must not stall fan-out to the rest. The socket
        // will be pruned when its close event fires (handled by the wiring).
      }
    }
  }
}
