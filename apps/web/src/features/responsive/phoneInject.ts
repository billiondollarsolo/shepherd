/**
 * Phone stage inject: send keystrokes into a session's PTY via the same framing
 * as the desktop terminal (pty:<sessionId> WebSocket).
 *
 * The orchestrator registry silently no-ops write until subscribe finishes
 * (pty-session-registry.write). We MUST wait for the server control
 * `{ op: 'attached' }` before sending input, then close.
 */
import { encodePtyInput, ptyWebSocketUrl } from '../terminal/ptyProtocol';

export type PhoneWsLike = {
  readyState: number;
  binaryType?: string;
  send: (data: string | ArrayBufferView | ArrayBuffer) => void;
  close: () => void;
  onopen: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
};

export type PhoneWsFactory = (url: string) => PhoneWsLike;

const WS_OPEN = 1;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Build the binary frame for phone stage input.
 * - submit=false: stage text only (no CR)
 * - submit=true: append CR so the agent receives the line
 */
export function phoneInjectPayload(text: string, submit: boolean): Uint8Array {
  const body = submit ? (text.endsWith('\r') ? text : `${text}\r`) : text;
  return encodePtyInput(body);
}

/** True when a parsed control frame means the PTY is ready to accept input. */
export function isPtyAttachedControl(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  try {
    const msg = JSON.parse(data) as { channel?: string; op?: string };
    return msg.channel === 'pty' && msg.op === 'attached';
  } catch {
    return false;
  }
}

/** True when attach failed (server closed without ready). */
export function isPtyDetachedControl(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  try {
    const msg = JSON.parse(data) as { channel?: string; op?: string };
    return msg.channel === 'pty' && (msg.op === 'detached' || msg.op === 'exited');
  } catch {
    return false;
  }
}

/**
 * Open a PTY websocket, wait until the server reports `attached`, send one
 * framed payload, then close. Rejects if attach never completes or write cannot
 * be delivered.
 */
export function sendPhoneInject(
  sessionId: string,
  text: string,
  submit: boolean,
  opts?: {
    wsFactory?: PhoneWsFactory;
    timeoutMs?: number;
  },
): Promise<{ sessionId: string; bytes: number }> {
  const payload = phoneInjectPayload(text, submit);
  const factory: PhoneWsFactory =
    opts?.wsFactory ??
    ((url: string) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      return ws as unknown as PhoneWsLike;
    });
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let attached = false;
    let sent = false;
    const ws = factory(ptyWebSocketUrl(sessionId));

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.onopen = ws.onerror = ws.onmessage = ws.onclose = null;
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    const fail = (err: Error): void => finish(() => reject(err));
    const ok = (): void =>
      finish(() => resolve({ sessionId, bytes: payload.byteLength }));

    const timer = setTimeout(() => {
      fail(
        new Error(
          attached
            ? 'phone inject: send timed out after attach'
            : 'phone inject: PTY attach timed out (transport not ready)',
        ),
      );
    }, timeoutMs);

    const trySend = (): void => {
      if (!attached || sent || settled) return;
      if (ws.readyState !== WS_OPEN) {
        fail(new Error('phone inject: socket not open when ready to send'));
        return;
      }
      try {
        ws.send(payload);
        sent = true;
        ok();
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    };

    ws.onerror = () => {
      fail(new Error('phone inject socket error'));
    };

    ws.onclose = () => {
      if (settled) return;
      if (!attached) {
        fail(new Error('phone inject: closed before PTY attach'));
      } else if (!sent) {
        fail(new Error('phone inject: closed before input delivered'));
      }
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      // Binary = PTY output (scrollback replay); ignore for attach readiness.
      if (typeof data !== 'string') return;
      if (isPtyDetachedControl(data)) {
        fail(new Error('phone inject: PTY detached before input delivered'));
        return;
      }
      if (isPtyAttachedControl(data)) {
        attached = true;
        trySend();
      }
    };

    ws.onopen = () => {
      // Wait for server auto-subscribe + `attached` control before any write.
      // Sending on open alone hits registry.write while not yet tracked → silent no-op.
      if (ws.readyState !== WS_OPEN) {
        fail(new Error('phone inject: socket not open after onopen'));
      }
    };
  });
}
