import { z } from 'zod';
import { ConnectionStatusEnum, IsoTimestamp, Uuid } from '../domain.js';
import { StatusEnum } from '../status.js';

// ===========================================================================
// 8.2 WebSocket (one authed socket, multiplexed)
// ===========================================================================

/**
 * Live per-session agent telemetry that RIDES the status fan-out (no DB read) so
 * the paddock's token/tool/model/context%/cost gauges update over the WebSocket
 * instead of a fixed-interval poll. All fields optional — the daemon omits
 * unchanged ones, and a session with no transcript telemetry carries none.
 */
export const AgentTelemetry = z.object({
  tokens: z.number().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  contextPct: z.number().optional(),
  /** Raw context-window occupancy + limit, so the UI can show "120k / 200k", not
   *  just a percent. Limit is exact when the agent reports it, else the model table. */
  contextTokens: z.number().optional(),
  contextLimit: z.number().optional(),
  costUsd: z.number().optional(),
});
export type AgentTelemetry = z.infer<typeof AgentTelemetry>;

/**
 * The `status` channel payload — fanned out on every transition (spec §8.2).
 * This is the live-path message; it carries NO data that requires a DB read.
 * `meta` is optional live telemetry (US — polling→WS): present on agent frames,
 * absent on plain transitions (OSC fallback, boot restore, lifecycle).
 */
export const StatusUpdateMessage = z.object({
  channel: z.literal('status'),
  sessionId: Uuid,
  status: StatusEnum,
  detail: z.string().nullable(),
  ts: IsoTimestamp,
  /** ISO timestamp of last semantic status change (Agents sort key). */
  lastStatusTransitionAt: IsoTimestamp.optional(),
  meta: AgentTelemetry.optional(),
});
export type StatusUpdateMessage = z.infer<typeof StatusUpdateMessage>;

/** The `nodes` channel payload — node connection-status changes. */
export const NodeUpdateMessage = z.object({
  channel: z.literal('nodes'),
  nodeId: Uuid,
  connectionStatus: ConnectionStatusEnum,
  lastSeenAt: IsoTimestamp.nullable(),
  ts: IsoTimestamp,
});
export type NodeUpdateMessage = z.infer<typeof NodeUpdateMessage>;

/**
 * Control envelope for `pty:<sessionId>` data. The binary PTY bytes ride the
 * socket as binary frames; this JSON envelope carries non-binary control
 * (resize, subscribe ack) for the same logical channel.
 */
export const PtyControlMessage = z.object({
  channel: z.literal('pty'),
  sessionId: Uuid,
  // `exited` = the PTY's process (the agent / shell) ended and the tmux session
  // is gone — TERMINAL, not a transient drop, so the client must NOT reconnect.
  op: z.enum(['attached', 'resize', 'detached', 'exited']),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  /** Process exit code on `exited` (null when killed by a signal). */
  exitCode: z.number().int().nullable().optional(),
  /** Terminating signal on `exited`, if any. */
  signal: z.string().nullable().optional(),
});
export type PtyControlMessage = z.infer<typeof PtyControlMessage>;

/** Server→client message union (JSON frames). */
export const ServerMessage = z.discriminatedUnion('channel', [
  StatusUpdateMessage,
  NodeUpdateMessage,
  PtyControlMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Client→server control messages: subscribe/unsubscribe to channels and
 * forward PTY resize / browser input intents.
 */
export const ClientSubscribeMessage = z.object({
  op: z.literal('subscribe'),
  channel: z.enum(['status', 'nodes', 'pty', 'screencast']),
  /** Required for the per-session channels (pty/screencast). */
  sessionId: Uuid.optional(),
});
export type ClientSubscribeMessage = z.infer<typeof ClientSubscribeMessage>;

export const ClientUnsubscribeMessage = z.object({
  op: z.literal('unsubscribe'),
  channel: z.enum(['status', 'nodes', 'pty', 'screencast']),
  sessionId: Uuid.optional(),
});
export type ClientUnsubscribeMessage = z.infer<typeof ClientUnsubscribeMessage>;

export const ClientPtyResizeMessage = z.object({
  op: z.literal('pty:resize'),
  sessionId: Uuid,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type ClientPtyResizeMessage = z.infer<typeof ClientPtyResizeMessage>;

export const ClientMessage = z.discriminatedUnion('op', [
  ClientSubscribeMessage,
  ClientUnsubscribeMessage,
  ClientPtyResizeMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
