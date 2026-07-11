/** Scalable fleet-scope menu for local and remote nodes. */
import { sessionInHostScope, type HostScope } from '@flock/shared';
import type { Node as FlockNode, Session, Status } from '@flock/shared';
import { ChevronDown, Server } from 'lucide-react';
import { usePaddock } from '../../store/paddock';
import { useNodes, useSessions } from '../../data/queries';
import { useLiveStatuses, useAgentdHealth } from '../paddock/liveData';
import { orderNodes } from '../../store/paddock';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui';

function attentionCount(
  scope: HostScope,
  sessions: readonly Session[],
  statuses: ReadonlyMap<string, Status>,
  nodes: readonly FlockNode[],
): number {
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

  const allAttn = attentionCount('all', sessions, statuses, nodes);
  const selectedNodeId =
    typeof hostScope === 'object' && 'nodeId' in hostScope ? hostScope.nodeId : null;
  const selectedPool = typeof hostScope === 'object' && 'pool' in hostScope ? hostScope.pool : null;
  const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) : null;
  const selectedLabel =
    selectedNode?.name ?? (selectedPool ? `Pool: ${selectedPool}` : 'All hosts');
  const selectedAttention = attentionCount(hostScope, sessions, statuses, nodes);
  const selectedValue = selectedNodeId
    ? `node:${selectedNodeId}`
    : selectedPool
      ? `pool:${selectedPool}`
      : 'all';
  const pools = [
    ...new Set(ordered.map((node) => node.pool).filter((pool): pool is string => !!pool)),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Fleet scope"
          className="max-w-64 justify-start"
          data-testid="host-scope-menu"
        >
          <Server />
          <span className="font-semibold">Fleet scope</span>
          <span className="truncate text-2xs font-normal text-flock-ink-muted">
            {selectedLabel}
          </span>
          {selectedAttention > 0 ? (
            <span className="rounded-full bg-status-awaiting/20 px-1.5 tabular-nums text-status-awaiting">
              {selectedAttention}
            </span>
          ) : null}
          <ChevronDown className="ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Fleet scope</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selectedValue}
          onValueChange={(value) => {
            if (value === 'all') setHostScope('all');
            else if (value.startsWith('node:')) setHostScope({ nodeId: value.slice(5) });
            else if (value.startsWith('pool:')) setHostScope({ pool: value.slice(5) });
          }}
        >
          <DropdownMenuRadioItem value="all">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate">All hosts</span>
              {allAttn > 0 ? (
                <span className="ml-auto text-2xs tabular-nums text-status-awaiting">
                  {allAttn} need you
                </span>
              ) : null}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {ordered.map((node) => {
            const link = (health as { nodes?: Record<string, { link?: string }> } | null)?.nodes?.[
              node.id
            ]?.link;
            const connected = link === 'up' || node.connectionStatus === 'connected';
            const attention = attentionCount({ nodeId: node.id }, sessions, statuses, nodes);
            return (
              <DropdownMenuRadioItem key={node.id} value={`node:${node.id}`}>
                <span
                  className={`size-1.5 rounded-full ${
                    connected ? 'bg-status-idle' : 'bg-status-disconnected'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {attention > 0 ? (
                  <span className="text-2xs tabular-nums text-status-awaiting">{attention}</span>
                ) : null}
              </DropdownMenuRadioItem>
            );
          })}
          {pools.length > 0 ? <DropdownMenuSeparator /> : null}
          {pools.map((pool) => {
            const attention = attentionCount({ pool }, sessions, statuses, nodes);
            return (
              <DropdownMenuRadioItem key={pool} value={`pool:${pool}`}>
                <span className="min-w-0 flex-1 truncate">Pool: {pool}</span>
                {attention > 0 ? (
                  <span className="text-2xs tabular-nums text-status-awaiting">{attention}</span>
                ) : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {ordered.length === 0 ? (
          <div className="px-2 py-2 text-xs text-flock-ink-muted">No hosts configured.</div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
