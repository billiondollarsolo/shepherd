/**
 * BottomBar — a thin VS Code-style status strip across the bottom of the paddock.
 * Shows the ACTIVE session's node (name + live CPU%/mem, click → node info) and,
 * when a session is selected, the agent's status dot + current tool + token count.
 * Falls back to the local node's metrics when nothing is selected.
 */
import { Cpu } from 'lucide-react';
import { statusLabel, type Status } from '@flock/shared';
import { useNodeInfo, useNodes, useSessions } from '../../data/queries';
import { usePaddock } from '../../store/paddock';
import { useAgentdHealth, useLiveStatuses } from './liveData';
import { ContextMeter } from './ContextMeter';
import { formatCostUsd, formatGB, formatTokens, isShellProcess } from '../../lib/utils';
import { StatusDot } from '../../components/StatusDot';

export function BottomBar(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const { data: sessions = [] } = useSessions();
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const statuses = useLiveStatuses();
  const health = useAgentdHealth();

  const session = selectedId ? (sessions.find((x) => x.id === selectedId) ?? null) : null;
  const nodeId =
    session?.nodeId ?? nodes.find((n) => n.kind === 'local')?.id ?? nodes[0]?.id ?? null;
  const node = nodes.find((n) => n.id === nodeId) ?? null;
  const { data: info } = useNodeInfo(nodeId);

  const status: Status | null = session ? (statuses.get(session.id) ?? session.status) : null;
  const usage = session ? health?.sessions[session.id] : undefined;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--flock-border)] bg-flock-surface-1 px-3 text-2xs text-flock-ink-muted">
      {node ? (
        <button
          type="button"
          onClick={() => openNodeInfo(node.id)}
          className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-flock-surface-2 hover:text-flock-ink-primary"
          title="Node info"
        >
          <Cpu className="size-3" />
          <span className="font-medium text-flock-ink-primary">{node.name}</span>
          {info ? (
            <>
              <span className="tabular-nums">{Math.round(info.cpuPercent)}% CPU</span>
              <span className="tabular-nums">
                {formatGB(info.memUsed)}/{formatGB(info.memTotal)} GB
              </span>
              <span
                className="tabular-nums"
                title="Disk used on this node (a filling disk is a silent failure mode)"
              >
                {formatGB(info.diskUsed)}/{formatGB(info.diskTotal)} GB disk
              </span>
            </>
          ) : (
            <span className="opacity-60">…</span>
          )}
        </button>
      ) : (
        <span className="opacity-60">No node</span>
      )}

      {session ? (
        <div className="ml-auto flex items-center gap-2">
          {status ? (
            <span className="flex items-center gap-1.5">
              <StatusDot status={status} />
              {statusLabel(status)}
            </span>
          ) : null}
          <span className="text-flock-ink-muted/70">{session.agentType}</span>
          {usage?.model ? (
            <span className="max-w-[12rem] truncate text-flock-ink-muted/70" title={usage.model}>
              {usage.model}
            </span>
          ) : null}
          {usage?.tool && !isShellProcess(usage.tool) ? (
            <span className="max-w-[18rem] truncate">{usage.tool}</span>
          ) : null}
          {usage?.contextPct != null ? (
            <ContextMeter
              pct={usage.contextPct}
              tokens={usage.contextTokens}
              limit={usage.contextLimit}
            />
          ) : null}
          {usage?.tokens ? (
            <span className="tabular-nums">{formatTokens(usage.tokens)} tok</span>
          ) : null}
          {usage?.costUsd != null ? (
            <span className="tabular-nums" title="Estimated cost for this session">
              {formatCostUsd(usage.costUsd)}
            </span>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}

export default BottomBar;
