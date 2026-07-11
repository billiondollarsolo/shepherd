/** Paddock fleet home: node cards only; details live on the node page. */
import { useMemo } from 'react';
import { HardDrive } from 'lucide-react';
import { displayStatus, type Session, type Status } from '@flock/shared';
import { StatusDot } from '../../components/StatusDot';
import { useNodeInfos, useNodes, useProjects, useSessions } from '../../data/queries';
import { formatGB } from '../../lib/utils';
import { orderNodes, usePaddock } from '../../store/paddock';
import { useLiveStatuses } from '../paddock/liveData';

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
  const tone =
    width >= 90 ? 'bg-status-error' : width >= 70 ? 'bg-status-awaiting' : 'bg-flock-accent';
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
  const nodeInfos = useNodeInfos(visibleNodes.map((node) => node.id));
  const openSessions = useMemo(
    () => sessions.filter((session) => session.closedAt === null),
    [sessions],
  );
  const statusOf = (session: Session): Status => live.get(session.id) ?? session.status;

  return (
    <div className="h-full overflow-y-auto bg-flock-surface-0" data-testid="fleet-hierarchy">
      <header className="border-b border-[var(--flock-border)] px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-flock-ink-primary">Paddock</h1>
        <p className="mt-0.5 text-sm text-flock-ink-muted">
          Your nodes and their current workload.
        </p>
      </header>

      <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-4 p-4 sm:p-6 md:grid-cols-2 2xl:grid-cols-3">
        {visibleNodes.map((node) => {
          const nodeProjects = projects.filter((project) => project.nodeId === node.id);
          const nodeSessions = openSessions.filter((session) => session.nodeId === node.id);
          const info = nodeInfos.get(node.id);
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
              className="group flex min-h-56 flex-col rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-5 text-left shadow-sm transition-colors hover:border-flock-accent/50 hover:bg-flock-surface-2"
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
                      className={`size-2 rounded-full ${CONNECTION_COLOR[node.connectionStatus] ?? 'bg-status-disconnected'}`}
                    />
                  </span>
                  <span className="block truncate text-xs capitalize text-flock-ink-muted">
                    {node.connectionStatus} · {node.kind}
                    {node.host ? ` · ${node.host}` : ''}
                  </span>
                </span>
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
                  return [
                    <span
                      key={status}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--flock-border)] bg-flock-surface-0 px-2 py-1 text-2xs text-flock-ink-muted"
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
      </div>
    </div>
  );
}
