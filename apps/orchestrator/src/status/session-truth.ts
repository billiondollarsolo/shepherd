/**
 * Session ground-truth reconciliation.
 *
 * After an orchestrator restart (or when a node drops), the DB write-behind
 * mirror can still say `running`/`starting`/`idle` long after the node or PTY is
 * gone — or stay stuck on `disconnected` after the PTY is back. The live UI
 * prefers the in-memory status map; this module plans the corrections so the
 * map (and its write-behind) always reflect reality:
 *
 *   - node not connected → every open work-status session becomes `disconnected`
 *   - node connected but agentd has no PTY for the session → `disconnected`
 *   - node connected and agentd has the PTY while status is `disconnected`
 *     → restore to `idle` (hooks will refine to running/awaiting/etc.)
 *   - agentd probe unavailable on a connected node → leave alone (transient)
 *   - terminal `done`/`error` → leave alone (already truthful end states)
 */
import type { ConnectionStatus, Status } from '@flock/shared';

/** Open session row needed to plan truth corrections. */
export interface SessionTruthRow {
  readonly id: string;
  readonly nodeId: string;
  /** Current live (or rehydrated) status, if known. */
  readonly status: Status | undefined;
}

/** Per-node connectivity + optional agentd session inventory. */
export interface NodeTruth {
  readonly kind: 'local' | 'ssh';
  /**
   * Live SSH/local reachability. Local is always treated as `connected` when the
   * host process is up; SSH uses the supervised link (or DB mirror fallback).
   */
  readonly connection: ConnectionStatus;
  /**
   * Session ids currently present on that node's flock-agentd.
   * `null` means "could not probe" (do not invent a disconnect).
   */
  readonly liveSessionIds: ReadonlySet<string> | null;
}

export interface SessionTruthCorrection {
  readonly id: string;
  readonly status: 'disconnected' | 'idle';
  readonly detail: string;
}

/** Statuses that claim an agent/PTY is still active and must not stay stale. */
const ACTIVE_CLAIM: ReadonlySet<Status> = new Set([
  'starting',
  'running',
  'awaiting_input',
  'idle',
]);

function connectionDetail(connection: ConnectionStatus): string {
  switch (connection) {
    case 'error':
      return 'node unreachable';
    case 'disconnected':
      return 'node disconnected';
    case 'connecting':
      return 'node connecting';
    default:
      return `node ${connection}`;
  }
}

/**
 * Plan which open sessions must flip given node connectivity and agentd
 * liveness. Pure — no I/O; caller applies via {@link StatusMap.set}.
 *
 * Emits:
 *   - `disconnected` when a work-status claim is false (node down / PTY gone)
 *   - `idle` when a session is marked disconnected but agentd still has it live
 */
export function planSessionTruth(
  sessions: ReadonlyArray<SessionTruthRow>,
  nodes: ReadonlyMap<string, NodeTruth>,
): SessionTruthCorrection[] {
  const out: SessionTruthCorrection[] = [];

  for (const session of sessions) {
    const current = session.status;
    // Terminal end-states stay as-is.
    if (current === 'done' || current === 'error') {
      continue;
    }

    const node = nodes.get(session.nodeId);
    if (!node) {
      if (current !== 'disconnected') {
        out.push({
          id: session.id,
          status: 'disconnected',
          detail: 'node missing',
        });
      }
      continue;
    }

    if (node.connection !== 'connected') {
      // Already disconnected is fine; re-assert only when we were claiming work.
      if (current === 'disconnected') continue;
      if (current !== undefined && !ACTIVE_CLAIM.has(current)) continue;
      out.push({
        id: session.id,
        status: 'disconnected',
        detail: connectionDetail(node.connection),
      });
      continue;
    }

    // Node is connected.
    if (node.liveSessionIds === null) continue; // transient probe — do nothing

    if (node.liveSessionIds.has(session.id)) {
      // PTY is live: clear a stuck disconnected (common after orchestrator
      // restart rehydrates the DB mirror before hooks re-emit).
      if (current === 'disconnected' || current === undefined) {
        out.push({
          id: session.id,
          status: 'idle',
          detail: 'session restored on node',
        });
      }
      continue;
    }

    // Agentd positively reports absence of this session's PTY.
    // Unknown / never-seeded: only correct if we can prove the claim is false.
    // If status is undefined we still correct (UI would otherwise fall back to a
    // stale REST mirror claiming work).
    if (current !== undefined && current !== 'disconnected' && !ACTIVE_CLAIM.has(current)) {
      continue;
    }

    // Refresh detail even if already disconnected (e.g. was "node unreachable"
    // while the VM was off — now the node is back but the PTY is still gone).
    out.push({
      id: session.id,
      status: 'disconnected',
      detail: 'session not running on node',
    });
  }

  return out;
}
