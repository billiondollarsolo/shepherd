/** Paddock fleet home: node cards only; details live on the node page. */
import { useMemo, useState, type CSSProperties } from 'react';
import { HardDrive } from 'lucide-react';
import { displayStatus, ringsSidebar, type Session, type Status } from '@flock/shared';
import { StatusDot } from '../../components/StatusDot';
import { Badge } from '../../components/ui';
import { statusCssVar } from '../../theme/tokens';
import { useNodeInfos, useNodes, useProjects, useSessions } from '../../data/queries';
import { formatGB } from '../../lib/utils';
import { orderNodes, usePaddock } from '../../store/paddock';
import { useLiveStatuses } from '../paddock/liveData';
import { buildFleetIndex, FLEET_PAGE_SIZE, nextFleetLimit } from './fleetModel';

const CONNECTION_COLOR: Record<string, string> = {
  connected: 'bg-status-idle',
  connecting: 'bg-status-awaiting',
  disconnected: 'bg-status-disconnected',
  error: 'bg-status-error',
};

const STATUS_PRIORITY: Status[] = [
  'awaiting_input',
  'error',
  'running',
  'starting',
  'done',
  'idle',
  'disconnected',
];

function Metric({
  label,
  percent,
  value,
}: {
  label: string;
  percent: number;
  value: string;
}): JSX.Element {
  const width = Math.max(0, Math.min(100, Math.round(percent)));
  // Infra telemetry bars are deliberately NEUTRAL (never accent/status): they must
  // not out-shout the attention/status row that answers "which agent needs me"
  // (Phase 3 §3.4). The percentage/value text carries the load; the bar is texture.
  const tone = 'bg-flock-ink-muted/50';
  return (
    <span className="block">
      <span className="flex items-center text-2xs text-flock-ink-muted">
        <span>{label}</span>
        <span className="ml-auto tabular-nums">{value}</span>
      </span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-flock-surface-3">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

export function FleetView(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useSessions();
  const live = useLiveStatuses();
  const nodeOrder = usePaddock((s) => s.nodeOrder);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const visibleNodes = useMemo(() => orderNodes(nodes, nodeOrder), [nodeOrder, nodes]);
  const [nodeLimit, setNodeLimit] = useState(FLEET_PAGE_SIZE);
  const fleetIndex = useMemo(() => buildFleetIndex(projects, sessions), [projects, sessions]);
  const statusOf = (session: Session): Status => live.get(session.id) ?? session.status;

  // Per-node attention rollup: how many of a node's open sessions are in a state
  // that "demands attention" (awaiting_input/error), decided ONCE via the shared
  // ringsSidebar() policy so awaiting and error read identically here and in the
  // tree. `status` is the node's dominant ringing state (awaiting outranks error)
  // and drives the ring hue + the pulse's --flock-indicator-color.
  const attentionByNode = useMemo(() => {
    const map = new Map<string, { count: number; status: Status }>();
    for (const node of visibleNodes) {
      const nodeSessions = fleetIndex.openSessionsByNode.get(node.id) ?? [];
      let count = 0;
      let awaiting = false;
      for (const session of nodeSessions) {
        const status = live.get(session.id) ?? session.status;
        if (!ringsSidebar(status)) continue;
        count += 1;
        if (status === 'awaiting_input') awaiting = true;
      }
      if (count > 0) map.set(node.id, { count, status: awaiting ? 'awaiting_input' : 'error' });
    }
    return map;
  }, [visibleNodes, fleetIndex, live]);

  // Float the nodes that need you to the top; a stable partition keeps the user's
  // saved node order intact WITHIN each group.
  const sortedNodes = useMemo(() => {
    const needsAttention: typeof visibleNodes = [];
    const rest: typeof visibleNodes = [];
    for (const node of visibleNodes) {
      if (attentionByNode.has(node.id)) needsAttention.push(node);
      else rest.push(node);
    }
    return [...needsAttention, ...rest];
  }, [visibleNodes, attentionByNode]);

  const displayedNodes = sortedNodes.slice(0, nodeLimit);
  const nodeInfos = useNodeInfos(
    displayedNodes.filter((node) => node.connectionStatus === 'connected').map((node) => node.id),
  );

  return (
    <div className="h-full overflow-y-auto bg-flock-surface-0" data-testid="fleet-hierarchy">
      <header className="border-b border-[var(--flock-border)] px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-flock-ink-primary">Paddock</h1>
        <p className="mt-0.5 text-sm text-flock-ink-muted">
          Your nodes and their current workload.
        </p>
      </header>

      <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-4 p-4 sm:p-6 md:grid-cols-2 2xl:grid-cols-3">
        {displayedNodes.map((node) => {
          const nodeProjects = fleetIndex.projectsByNode.get(node.id) ?? [];
          const nodeSessions = fleetIndex.openSessionsByNode.get(node.id) ?? [];
          const info = nodeInfos.get(node.id);
          const attention = attentionByNode.get(node.id);
          const attentionRing =
            attention &&
            (attention.status === 'error'
              ? 'border-status-error ring-2 ring-status-error'
              : 'border-status-awaiting ring-2 ring-status-awaiting');
          const counts = new Map<Status, number>();
          for (const session of nodeSessions) {
            const status = statusOf(session);
            counts.set(status, (counts.get(status) ?? 0) + 1);
          }
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => openNodeInfo(node.id)}
              className={`group flex min-h-56 flex-col rounded-xl border bg-flock-surface-1 p-5 text-left shadow-sm transition-colors hover:bg-flock-surface-2 ${
                attention
                  ? `${attentionRing} animate-flock-pulse`
                  : 'border-[var(--flock-border)] hover:border-flock-accent/50'
              }`}
              // The signature ring pulses with the dominant status hue; under
              // prefers-reduced-motion the animation is neutralized globally and the
              // static ring-2 persists as the still-legible fallback.
              style={
                attention
                  ? ({
                      '--flock-indicator-color': `var(${statusCssVar(attention.status)})`,
                    } as CSSProperties)
                  : undefined
              }
              data-testid={`node-card-${node.id}`}
            >
              <div className="flex w-full items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-flock-surface-2 text-flock-ink-muted group-hover:text-flock-accent">
                  <HardDrive className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-base font-semibold text-flock-ink-primary">
                      {node.name}
                    </span>
                    <span
                      role="img"
                      aria-label={`Connection: ${node.connectionStatus}`}
                      className={`size-2 rounded-full ${CONNECTION_COLOR[node.connectionStatus] ?? 'bg-status-disconnected'}`}
                    />
                  </span>
                  <span className="block truncate text-xs capitalize text-flock-ink-muted">
                    {node.connectionStatus} · {node.kind}
                    {node.host ? ` · ${node.host}` : ''}
                  </span>
                </span>
                {attention ? (
                  <Badge
                    variant={attention.status === 'error' ? 'danger' : 'warning'}
                    dot
                    className="shrink-0"
                    data-testid={`node-attention-${node.id}`}
                  >
                    {attention.count} need{attention.count === 1 ? 's' : ''} you
                  </Badge>
                ) : null}
              </div>

              <div className="mt-5 grid w-full grid-cols-2 gap-2">
                <span className="rounded-lg bg-flock-surface-0 px-3 py-2">
                  <span className="block text-lg font-semibold tabular-nums text-flock-ink-primary">
                    {nodeProjects.length}
                  </span>
                  <span className="text-2xs text-flock-ink-muted">Projects</span>
                </span>
                <span className="rounded-lg bg-flock-surface-0 px-3 py-2">
                  <span className="block text-lg font-semibold tabular-nums text-flock-ink-primary">
                    {nodeSessions.length}
                  </span>
                  <span className="text-2xs text-flock-ink-muted">Agents</span>
                </span>
              </div>

              <div className="mt-4 flex w-full flex-wrap gap-1.5">
                {STATUS_PRIORITY.flatMap((status) => {
                  const count = counts.get(status) ?? 0;
                  if (count === 0) return [];
                  // Tint the "needs you" pills (awaiting_input/error) with their status
                  // token so the two attention states stand out from the muted roster;
                  // the ring/dot policy stays owned by ringsSidebar().
                  const pillClass = ringsSidebar(status)
                    ? status === 'error'
                      ? 'border-status-error/40 bg-status-error/10 text-flock-ink-primary'
                      : 'border-status-awaiting/40 bg-status-awaiting/10 text-flock-ink-primary'
                    : 'border-[var(--flock-border)] bg-flock-surface-0 text-flock-ink-muted';
                  return [
                    <span
                      key={status}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-2xs ${pillClass}`}
                    >
                      <StatusDot status={status} />
                      {count} {displayStatus(status).label}
                    </span>,
                  ];
                })}
                {nodeSessions.length === 0 ? (
                  <span className="text-xs text-flock-ink-muted">No active agents</span>
                ) : null}
              </div>

              <div className="mt-4 grid w-full gap-2.5 border-t border-[var(--flock-border)] pt-3">
                {info ? (
                  <>
                    <Metric
                      label="CPU"
                      percent={info.cpuPercent}
                      value={`${Math.round(info.cpuPercent)}%`}
                    />
                    <Metric
                      label="Memory"
                      percent={info.memTotal > 0 ? (info.memUsed / info.memTotal) * 100 : 0}
                      value={`${formatGB(info.memUsed, true)} / ${formatGB(info.memTotal, true)}`}
                    />
                    <Metric
                      label="Storage"
                      percent={info.diskTotal > 0 ? (info.diskUsed / info.diskTotal) * 100 : 0}
                      value={`${formatGB(info.diskUsed, true)} / ${formatGB(info.diskTotal, true)}`}
                    />
                  </>
                ) : (
                  <span className="text-xs text-flock-ink-muted">Metrics unavailable</span>
                )}
              </div>

              <span className="mt-auto pt-4 text-xs font-medium text-flock-accent">
                View node details →
              </span>
            </button>
          );
        })}

        {visibleNodes.length === 0 ? (
          <div className="col-span-full rounded-xl border border-dashed border-[var(--flock-border)] p-10 text-center text-sm text-flock-ink-muted">
            No nodes are connected.
          </div>
        ) : null}
        {displayedNodes.length < visibleNodes.length ? (
          <button
            type="button"
            onClick={() => setNodeLimit((current) => nextFleetLimit(current, visibleNodes.length))}
            className="col-span-full rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-4 py-3 text-sm font-medium text-flock-accent hover:bg-flock-surface-2"
          >
            Show {Math.min(FLEET_PAGE_SIZE, visibleNodes.length - displayedNodes.length)} more nodes
            <span className="ml-2 text-flock-ink-muted">
              ({displayedNodes.length} of {visibleNodes.length})
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
