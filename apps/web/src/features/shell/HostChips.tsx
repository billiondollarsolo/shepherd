/**
 * Host chips — multi-node scope switcher (herdr multi-bridge analogue).
 */
import { sessionInHostScope, type HostScope } from '@flock/shared';
import type { Node as FlockNode, Session, Status } from '@flock/shared';
import { usePaddock } from '../../store/paddock';
import { useNodes, useSessions } from '../../data/queries';
import { useLiveStatuses, useAgentdHealth } from '../paddock/liveData';
import { orderNodes } from '../../store/paddock';

function attentionCount(
  nodeId: string | 'all',
  sessions: readonly Session[],
  statuses: ReadonlyMap<string, Status>,
  nodes: readonly FlockNode[],
  hostScope: HostScope,
): number {
  const scope: HostScope = nodeId === 'all' ? 'all' : { nodeId };
  return sessions.filter((s) => {
    if (s.closedAt) return false;
    if (!sessionInHostScope(scope, s, nodes)) return false;
    const st = statuses.get(s.id) ?? s.status;
    return st === 'awaiting_input' || st === 'error';
  }).length;
}

export function HostChips(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const { data: sessions = [] } = useSessions();
  const hostScope = usePaddock((s) => s.hostScope);
  const setHostScope = usePaddock((s) => s.setHostScope);
  const nodeOrder = usePaddock((s) => s.nodeOrder);
  const statuses = useLiveStatuses();
  const health = useAgentdHealth();
  const ordered = orderNodes(nodes, nodeOrder);

  const allAttn = attentionCount('all', sessions, statuses, nodes, 'all');

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="host-chips" role="toolbar" aria-label="Host scope">
      <Chip
        active={hostScope === 'all'}
        label="All"
        attention={allAttn}
        onClick={() => setHostScope('all')}
      />
      {ordered.map((n) => {
        const link = (health as { nodes?: Record<string, { link?: string }> } | null)?.nodes?.[
          n.id
        ]?.link;
        const conn = link === 'up' || n.connectionStatus === 'connected';
        const attn = attentionCount(n.id, sessions, statuses, nodes, { nodeId: n.id });
        return (
          <Chip
            key={n.id}
            active={typeof hostScope === 'object' && 'nodeId' in hostScope && hostScope.nodeId === n.id}
            label={n.name}
            attention={attn}
            connected={!!conn}
            onClick={() => setHostScope({ nodeId: n.id })}
          />
        );
      })}
    </div>
  );
}

function Chip({
  active,
  label,
  attention,
  connected,
  onClick,
}: {
  active: boolean;
  label: string;
  attention: number;
  connected?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`host-chip-${label}`}
      data-active={active ? '1' : '0'}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors ${
        active
          ? 'border-flock-accent bg-flock-accent/15 text-flock-ink-primary'
          : 'border-[var(--flock-border)] bg-flock-surface-1 text-flock-ink-muted hover:border-flock-accent/50'
      }`}
    >
      {connected !== undefined ? (
        <span
          className={`size-1.5 rounded-full ${connected ? 'bg-status-idle' : 'bg-status-disconnected'}`}
        />
      ) : null}
      <span className="max-w-[8rem] truncate">{label}</span>
      {attention > 0 ? (
        <span className="rounded-full bg-status-awaiting/20 px-1.5 tabular-nums text-status-awaiting">
          {attention}
        </span>
      ) : null}
    </button>
  );
}
