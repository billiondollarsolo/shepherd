/**
 * TS mirror of the flock-agentd wire format (Go side: agentd/proto).
 * Frame: [uint32 len][len bytes], body[0] = type, rest = payload. Control frames
 * carry JSON; PTY data frames carry [u16 sidLen][sid][bytes]. This lives in the
 * orchestrator (Node-only) — the browser never speaks to agentd.
 */
export const AGENTD_PROTOCOL_VERSION = 2;
/** Protocol codecs intentionally retained by this orchestrator build. */
export const AGENTD_CLIENT_PROTOCOL_VERSIONS = [2] as const;

export const FrameType = {
  Control: 0x01,
  PtyOutput: 0x02,
  PtyInput: 0x03,
  TcpOutput: 0x04,
  TcpInput: 0x05,
} as const;

/** Flat control message (mirrors the Go `Control` struct). */
export interface AgentdControl {
  op: string;
  protocolVersion?: number;
  daemonVersion?: string;
  nodeId?: string;
  clientNonce?: string;
  serverNonce?: string;
  serverMac?: string;
  clientMac?: string;
  capabilities?: string[];
  credentialId?: string;
  newCredential?: string;
  connectionRole?: 'control' | 'operation';
  id?: string;
  kind?: string;
  cwd?: string;
  env?: string[];
  command?: string[];
  /** Session transport: "" / "pty" (default) or "acp" (structured, F6). */
  mode?: string;
  cols?: number;
  rows?: number;
  code?: number;
  signal?: string;
  // exec_v1.
  input?: string;
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  // tcp_tunnel_v1.
  targetHost?: '127.0.0.1' | '::1';
  targetPort?: number;
  message?: string;
  sessions?: Array<{ id: string; kind: string; cwd: string }>;
  listeningPorts?: AgentdListeningPort[];
  observedAt?: string;
  discoveryError?: string;
  workspace?: string;
  layout?: unknown;
  // status (daemon→client): derived agent status for session `id`.
  state?: string;
  tokens?: number;
  tool?: string;
  // T19 — richer telemetry: model name + current context-window occupancy.
  model?: string;
  contextTokens?: number;
  contextLimit?: number; // T60: agent-reported context window (exact context-%)
  plan?: string; // T62: JSON [{content,status}] task list (Codex update_plan)
  // nodeInfo (daemon→client): host metrics + detected agents (NodeInfo JSON).
  nodeInfo?: unknown;
  // T17: Landlock FS sandbox for autonomous sessions on `open` (client→daemon).
  sandbox?: boolean;
  sandboxAllow?: string[];
  // T61: derive status from PTY activity (agents with no transcript/hook, e.g. gemini).
  activityStatus?: boolean;
  // Native hook-config injection (US-19) on `open` (client→daemon).
  configFiles?: Record<string, string>;
  configBaseSubdir?: string;
}

export interface AgentdListeningPort {
  observationKey: string;
  address: string;
  targetHost: '127.0.0.1' | '::1';
  port: number;
  pid?: number;
  process?: string;
  cwd?: string;
  sessionId?: string;
}

/**
 * The per-session telemetry carried on a `status` frame (daemon→client). Derived
 * from {@link AgentdControl} so it stays in sync automatically — a new telemetry
 * field added to the wire is picked up everywhere this type is used (the agentd
 * client handler + the orchestrator's status forwarder + meta cache).
 */
export type AgentdStatusMeta = Pick<
  AgentdControl,
  'tokens' | 'tool' | 'model' | 'contextTokens' | 'contextLimit' | 'plan'
>;

/** Frame one type+payload into a Buffer (`[u32 len][type][payload]`). */
export function encodeFrame(type: number, payload: Buffer): Buffer {
  const hdr = Buffer.allocUnsafe(5);
  hdr.writeUInt32BE(payload.length + 1, 0);
  hdr[4] = type;
  return Buffer.concat([hdr, payload]);
}

export function encodeControl(c: AgentdControl): Buffer {
  return encodeFrame(FrameType.Control, Buffer.from(JSON.stringify(c), 'utf8'));
}

/** PTY data payload: `[u16 sidLen][sid][bytes]`. */
function encodeDataPayload(sid: string, data: Buffer): Buffer {
  const sidb = Buffer.from(sid, 'utf8');
  const p = Buffer.allocUnsafe(2 + sidb.length + data.length);
  p.writeUInt16BE(sidb.length, 0);
  sidb.copy(p, 2);
  data.copy(p, 2 + sidb.length);
  return p;
}

export function encodePtyInput(sid: string, data: Buffer): Buffer {
  return encodeFrame(FrameType.PtyInput, encodeDataPayload(sid, data));
}

export function encodeTcpInput(data: Buffer): Buffer {
  return encodeFrame(FrameType.TcpInput, data);
}

export function decodeDataPayload(payload: Buffer): { sid: string; data: Buffer } {
  const l = payload.readUInt16BE(0);
  return { sid: payload.subarray(2, 2 + l).toString('utf8'), data: payload.subarray(2 + l) };
}

/**
 * Incremental frame parser: feed it socket chunks, get whole frames out. Holds a
 * carry buffer across chunks (TCP/socket reads don't respect frame boundaries).
 */
/**
 * T25 — max single-frame size, matching the Go daemon's 16 MiB cap. A bogus/huge
 * length prefix from a compromised or buggy daemon would otherwise make the
 * decoder buffer unboundedly (OOM) while waiting for bytes that never come.
 */
export const MAX_FRAME_BYTES = 16 << 20;

/** Thrown by {@link FrameDecoder.push} on an over-cap frame so the caller can
 * tear the connection down rather than buffer forever. */
export class FrameTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`agentd frame too large: ${size} bytes (max ${MAX_FRAME_BYTES})`);
    this.name = 'FrameTooLargeError';
  }
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (type: number, payload: Buffer) => void): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const n = this.buf.readUInt32BE(0);
      if (n > MAX_FRAME_BYTES) throw new FrameTooLargeError(n);
      if (this.buf.length < 4 + n) return;
      const body = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      onFrame(body[0]!, body.subarray(1));
    }
  }
}
