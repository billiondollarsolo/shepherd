/**
 * WebSocket keepalive + dead-connection reaper.
 *
 * The `ws` library does NOT ping automatically. An idle connection — e.g. a
 * terminal whose agent is sitting at a prompt producing no output — sends no
 * traffic, so browser/proxy idle timeouts silently drop it. In the UI that
 * surfaces as the terminal's "reconnecting…" (and a resize jump when it
 * re-attaches tmux). This pings every joined client on an interval and
 * terminates any that miss the next pong (a half-open / dead socket), keeping
 * live connections healthy through proxies.
 *
 * Applied to every orchestrator WS server (pty / status / screencast).
 */
import type { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_PING_MS = 30_000;

export function attachWsHeartbeat(wss: WebSocketServer, pingMs = DEFAULT_PING_MS): () => void {
  const alive = new WeakMap<WebSocket, boolean>();

  const onConnection = (ws: WebSocket): void => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  };
  wss.on('connection', onConnection);

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate(); // missed the previous ping's pong → dead
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, pingMs);
  // Never let the heartbeat keep the process alive on its own.
  timer.unref?.();

  return () => {
    clearInterval(timer);
    wss.off('connection', onConnection);
  };
}
