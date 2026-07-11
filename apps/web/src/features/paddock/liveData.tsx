/**
 * Shared live-data provider — ONE status WebSocket for the whole paddock, feeding
 * BOTH the live status map AND the per-session telemetry (tokens/tool/model/
 * context%/cost). The sidebar, tabs, and grid all consume the same context.
 *
 * Polling → WS: the telemetry used to come from a 4s `GET /api/agentd/status`
 * poll. It now RIDES the status fan-out (`StatusUpdateMessage.meta`) and is
 * written straight into the agentd-status query cache here, so the gauges update
 * the instant the agent reports — no fixed-interval HTTP churn. The query itself
 * is kept on a SLOW (30s) backstop only to refresh the per-node link health + the
 * precise daemon-list `live` flag (neither of which is on the status WS) and to
 * reconcile after a reconnect. See data/queries.ts `useAgentdStatus`.
 */
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentTelemetry, Status, StatusUpdateMessage } from '@flock/shared';

import { qk, useAgentdStatus } from '../../data/queries';
import type { AgentdHealth } from '../../data/treeApi';
import { useStatusWebSocket } from '../tree/useStatusWebSocket';

/** Live work-status per session id (from `/ws/status`); empty before first event. */
export const LiveStatusContext = createContext<ReadonlyMap<string, Status>>(new Map());
/** Last semantic status-change ms epoch per session (Agents "last change" sort). */
export const LiveStatusTransitionContext = createContext<ReadonlyMap<string, number>>(new Map());
/** flock-agentd health (per-node link + per-session tokens/tool/live), or null. */
export const AgentdHealthContext = createContext<AgentdHealth | null>(null);

/**
 * Merge one session's live telemetry from a status frame into the agentd-health
 * snapshot, without clobbering the per-node link health or the other sessions. A
 * reporting session is treated as `live` until the 30s snapshot reconciles the
 * exact daemon-list liveness. Pure (exported for tests).
 */
export function applyTelemetry(
  prev: AgentdHealth | undefined,
  sessionId: string,
  meta: AgentTelemetry,
): AgentdHealth {
  // Seeding from a WS telemetry frame ⇒ the daemon path is clearly enabled.
  const base: AgentdHealth = prev ?? { enabled: true, nodes: {}, sessions: {} };
  const cur = base.sessions[sessionId];
  return {
    ...base,
    sessions: {
      ...base.sessions,
      [sessionId]: {
        live: cur?.live ?? true,
        tokens: meta.tokens ?? cur?.tokens,
        tool: meta.tool ?? cur?.tool,
        model: meta.model ?? cur?.model,
        contextPct: meta.contextPct ?? cur?.contextPct,
        contextTokens: meta.contextTokens ?? cur?.contextTokens,
        contextLimit: meta.contextLimit ?? cur?.contextLimit,
        costUsd: meta.costUsd ?? cur?.costUsd,
      },
    },
  };
}

export function LiveDataProvider({ children }: { children: ReactNode }): JSX.Element {
  const qc = useQueryClient();
  // Write live telemetry from the status WS straight into the agentd-status cache.
  const onUpdate = useCallback(
    (msg: StatusUpdateMessage): void => {
      if (!msg.meta) return; // a plain transition (no telemetry) — leave the cache
      qc.setQueryData<AgentdHealth>(qk.agentdStatus, (prev) =>
        applyTelemetry(prev, msg.sessionId, msg.meta as AgentTelemetry),
      );
    },
    [qc],
  );
  const { statuses, lastStatusTransitionAt } = useStatusWebSocket({ onUpdate });
  const { data: agentdHealth = null } = useAgentdStatus();
  return (
    <LiveStatusContext.Provider value={statuses}>
      <LiveStatusTransitionContext.Provider value={lastStatusTransitionAt}>
        <AgentdHealthContext.Provider value={agentdHealth}>{children}</AgentdHealthContext.Provider>
      </LiveStatusTransitionContext.Provider>
    </LiveStatusContext.Provider>
  );
}

/** The live status map. */
export function useLiveStatuses(): ReadonlyMap<string, Status> {
  return useContext(LiveStatusContext);
}
/** The agentd health snapshot (or null). */
export function useAgentdHealth(): AgentdHealth | null {
  return useContext(AgentdHealthContext);
}
