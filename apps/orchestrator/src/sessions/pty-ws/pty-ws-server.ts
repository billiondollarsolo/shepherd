/**
 * PTY ⇄ WebSocket bridge server (US-11, spec §8.2 `pty:<sessionId>`).
 *
 * Wires the `ws` WebSocketServer to the {@link PtySessionRegistry}:
 *   - JSON text frames carry CONTROL (subscribe / unsubscribe / resize), parsed
 *     and validated with the SHARED zod contracts (ClientMessage); server→client
 *     control acks use the shared PtyControlMessage. No contract is duplicated.
 *   - BINARY frames carry raw PTY bytes both directions (US-11 "binary framing"):
 *     server→client is tmux output; client→server is keystrokes forwarded into
 *     the PTY. Binary keeps the hot path zero-copy and avoids base64 bloat.
 *
 * Multiplexing: each WebSocket may subscribe to ONE pty session at a time over
 * this endpoint (the URL is `/ws/pty/:sessionId`, and the client also sends a
 * `subscribe` control naming the same id). Two DIFFERENT sockets subscribing to
 * the SAME id share one {@link PtySession} (FR-S6) — that's the registry's job.
 *
 * Reconnect resume (US-11): on subscribe, the registry replays the session's
 * recent-output ring buffer to the newly attached socket, so a reconnecting tab
 * repaints immediately without disturbing the other viewer.
 *
 * Auth note: per spec §8.2 the live socket is authed; this module accepts an
 * optional `authenticate` hook so the bridge owner can reject unauthenticated
 * upgrades (NFR-SEC6) without this module owning the cookie/session logic.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  ClientMessage,
  type PtyControlMessage,
} from '@flock/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { attachWsHeartbeat } from '../../ws-heartbeat.js';

import type { PtySessionRegistry } from './pty-session-registry.js';
import type { PtySubscription } from './pty-session.js';

/** The URL path the bridge listens on; `:sessionId` is the trailing segment. */
export const PTY_WS_PATH_PREFIX = '/ws/pty/';

/** Optional per-connection auth; return true to allow, false to reject (401). */
export interface PtyWsAuthenticator {
  (req: IncomingMessage, sessionId: string): boolean | Promise<boolean>;
}

/** Options for {@link createPtyWsServer}. */
export interface PtyWsServerOptions {
  registry: PtySessionRegistry;
  /** Optional auth gate run before the upgrade completes (NFR-SEC6). */
  authenticate?: PtyWsAuthenticator;
}

/** Extract the session id from a `/ws/pty/<sessionId>` request URL. */
export function parseSessionIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  // Strip query string; the path may be absolute or relative.
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith(PTY_WS_PATH_PREFIX)) return null;
  const id = path.slice(PTY_WS_PATH_PREFIX.length);
  // Reject empty or nested paths.
  if (id.length === 0 || id.includes('/')) return null;
  return decodeURIComponent(id);
}

/**
 * Extract the optional initial terminal size (`?cols=&rows=`) from the request
 * URL, so a freshly-created PTY opens at the client's size (no startup reflow).
 * Returns null when absent or invalid.
 */
export function parseInitialSizeFromUrl(
  url: string | undefined,
): { cols: number; rows: number } | null {
  if (!url) return null;
  const q = url.split('?')[1];
  if (!q) return null;
  const params = new URLSearchParams(q);
  const cols = Number(params.get('cols'));
  const rows = Number(params.get('rows'));
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
  // Sane ceilings so a bogus query can't request an absurd PTY.
  return { cols: Math.min(cols, 1000), rows: Math.min(rows, 1000) };
}

/**
 * The bridge server. Owns a noServer WebSocketServer so it can share the
 * orchestrator's HTTP server (status WS, REST) via the `upgrade` event; call
 * {@link attach} to bind it to an http.Server, or {@link handleConnection}
 * directly in tests with an already-open socket.
 */
export class PtyWsServer {
  readonly wss: WebSocketServer;
  private readonly registry: PtySessionRegistry;
  private readonly authenticate?: PtyWsAuthenticator;
  private upgradeBound: HttpServer | null = null;
  private readonly stopHeartbeat: () => void;

  constructor(options: PtyWsServerOptions) {
    this.registry = options.registry;
    this.authenticate = options.authenticate;
    // noServer: we drive the handshake ourselves from the http `upgrade` event
    // so this endpoint can coexist with the other WS channels on one server.
    this.wss = new WebSocketServer({ noServer: true });
    // Keepalive: terminals idle for long stretches (agent waiting) would
    // otherwise be dropped by proxy/browser idle timeouts → "reconnecting".
    this.stopHeartbeat = attachWsHeartbeat(this.wss);
  }

  /**
   * Bind to an http.Server's `upgrade` event for the pty path. Other paths are
   * left untouched (so the status/screencast WS servers can claim them).
   */
  attach(server: HttpServer): void {
    if (this.upgradeBound) return;
    this.upgradeBound = server;
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket as Duplex, head);
    });
  }

  /** Handle one HTTP upgrade for the pty path; ignores non-pty paths. */
  async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const sessionId = parseSessionIdFromUrl(req.url);
    if (sessionId === null) {
      // Not our path — leave it for another upgrade handler. Do NOT destroy the
      // socket: another listener on the same server may own this path.
      return;
    }

    if (this.authenticate) {
      let ok = false;
      try {
        ok = await this.authenticate(req, sessionId);
      } catch {
        ok = false;
      }
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const initial = parseInitialSizeFromUrl(req.url) ?? undefined;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // handleUpgrade's callback does NOT emit 'connection', so the heartbeat's
      // pong tracking (attached via wss.on('connection')) never armed — every PTY
      // socket was then reaped as "dead" on the 2nd ping tick (~30-60s), causing
      // the periodic reconnect flapping. Emit it so the heartbeat tracks pongs.
      this.wss.emit('connection', ws, req);
      this.handleConnection(ws, sessionId, initial);
    });
  }

  /**
   * Drive one connected socket for one session. Exposed for tests that connect a
   * client directly. The socket subscribes to the shared PtySession; output is
   * pushed as binary frames; the resume buffer is replayed by the registry.
   */
  handleConnection(
    ws: WebSocket,
    sessionId: string,
    initial?: { cols: number; rows: number },
  ): void {
    let subscription: PtySubscription | null = null;
    let subscribing = false;

    const sendControl = (msg: PtyControlMessage): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const ensureSubscribed = async (
      cols?: number,
      rows?: number,
    ): Promise<void> => {
      if (subscription || subscribing) return;
      subscribing = true;
      try {
        if (cols && rows) {
          // Existing session: resize it. The size is ALSO passed to subscribe so a
          // NOT-yet-created PtySession opens its PTY at this size from the start.
          await this.registry.resize(sessionId, cols, rows);
        }
        subscription = await this.registry.subscribe(sessionId, {
          onData: (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              // Binary framing: raw PTY bytes, no envelope (US-11).
              ws.send(chunk);
            }
          },
          onExit: (event) => {
            if (event?.transient) {
              // The node LINK dropped, not the process — the daemon persisted the
              // session. Drop our (now-dead) PtySession so a reconnect rebuilds a
              // fresh transport, and close the socket WITHOUT 'exited' so the
              // browser reconnects + resumes (scrollback replays). No SIGWINCH /
              // prompt churn because resize is deduped on both ends.
              this.registry.closeSession(sessionId);
              ws.close();
              return;
            }
            // A genuine terminal exit: tell the client so it shows "exited" and
            // does NOT reconnect (re-attaching a dead session loops "exited").
            sendControl({
              channel: 'pty',
              sessionId,
              op: 'exited',
              exitCode: event?.exitCode ?? null,
              signal: event?.signal ?? null,
            });
            ws.close();
          },
        }, cols && rows ? { cols, rows } : undefined);
        sendControl({ channel: 'pty', sessionId, op: 'attached', cols, rows });
      } catch (err) {
        sendControl({ channel: 'pty', sessionId, op: 'detached' });
        ws.close(1011, err instanceof Error ? err.message : 'pty attach failed');
      } finally {
        subscribing = false;
      }
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Client → PTY: forward keystrokes/paste as-is (US-11 input forwarding).
        const buf = toBuffer(data);
        void this.registry.write(sessionId, buf);
        return;
      }

      // Text frame: a JSON control message validated against the shared contract.
      let parsed: unknown;
      try {
        parsed = JSON.parse(toBuffer(data).toString('utf8'));
      } catch {
        return; // ignore malformed control
      }
      const result = ClientMessage.safeParse(parsed);
      if (!result.success) return;
      const msg = result.data;

      switch (msg.op) {
        case 'subscribe':
          if (msg.channel === 'pty' && (msg.sessionId ?? sessionId) === sessionId) {
            void ensureSubscribed();
          }
          break;
        case 'unsubscribe':
          if (msg.channel === 'pty' && (msg.sessionId ?? sessionId) === sessionId) {
            subscription?.close();
            subscription = null;
            sendControl({ channel: 'pty', sessionId, op: 'detached' });
          }
          break;
        case 'pty:resize':
          if (msg.sessionId === sessionId) {
            void this.registry.resize(sessionId, msg.cols, msg.rows);
            sendControl({
              channel: 'pty',
              sessionId,
              op: 'resize',
              cols: msg.cols,
              rows: msg.rows,
            });
          }
          break;
        default:
          break; // screencast:quality etc. are not handled by this endpoint
      }
    });

    const teardown = (): void => {
      subscription?.close();
      subscription = null;
    };
    ws.on('close', teardown);
    ws.on('error', teardown);

    // Auto-subscribe on connect: the URL already named the session (and may carry
    // the initial size), so a viewer sees output immediately (incl. the resume
    // replay) and a fresh PTY opens at the right size — without a round-trip.
    void ensureSubscribed(initial?.cols, initial?.rows);
  }

  /** Close every client socket and release the noServer WSS. */
  close(): void {
    this.stopHeartbeat();
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.wss.close();
  }
}

/** Convenience factory mirroring the codebase's `build*`/`create*` style. */
export function createPtyWsServer(options: PtyWsServerOptions): PtyWsServer {
  return new PtyWsServer(options);
}

/** Normalise `ws`'s RawData (Buffer | ArrayBuffer | Buffer[]) to one Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
