/**
 * NodePage — a full-page node detail surface: connection (IP/port/SSH user/
 * status), host (OS/kernel/cores/uptime), live resource meters (CPU/mem/disk),
 * detected agent CLIs, and the sessions currently running on the node. Opened via
 * `openNodeInfo(nodeId)` (sidebar node header / bottom bar); the paddock `view`
 * switches to 'node', mirroring SettingsPage.
 */
import { ArrowLeft, Cpu, HardDrive, MemoryStick, SquareTerminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { BadgeProps } from '../../components/ui';
import { Badge, Button, ScrollArea } from '../../components/ui';
import { useNodeInfo, useNodes, useSessions } from '../../data/queries';
import { usePaddock } from '../../store/paddock';
import { formatGB } from '../../lib/utils';
import { useLiveStatuses } from './liveData';
import { StatusDot } from '../../components/StatusDot';
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  connected: 'success',
  connecting: 'accent',
  disconnected: 'outline',
  error: 'danger',
};

function Meter({
  icon: Icon,
  label,
  percent,
  value,
}: {
  icon: LucideIcon;
  label: string;
  percent: number;
  value: string;
}): JSX.Element {
  const tone =
    percent >= 90 ? 'bg-status-error' : percent >= 70 ? 'bg-status-awaiting' : 'bg-flock-accent';
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-3">
      <div className="flex items-center gap-2 text-sm">
        <Icon className="size-4 text-flock-ink-muted" />
        <span className="font-medium text-flock-ink-primary">{label}</span>
        <span className="ml-auto tabular-nums text-flock-ink-muted">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-flock-surface-2">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-flock-ink-muted">{label}</span>
      <span className="truncate text-right font-mono text-xs text-flock-ink-primary">{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-label text-flock-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

export function NodePage(): JSX.Element {
  const nodeId = usePaddock((s) => s.nodeInfoNodeId);
  const closeNodeInfo = usePaddock((s) => s.closeNodeInfo);
  const selectSession = usePaddock((s) => s.selectSession);
  const { data: nodes = [] } = useNodes();
  const { data: sessions = [] } = useSessions();
  const node = nodes.find((n) => n.id === nodeId) ?? null;
  const { data: info, isLoading, isError } = useNodeInfo(nodeId);

  const nodeSessions = sessions.filter((s) => s.nodeId === nodeId && s.closedAt === null);
  const liveStatuses = useLiveStatuses(); // overlay live WS status over the REST mirror

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-flock-surface-0 text-flock-ink-primary">
      <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-[var(--flock-border)] px-4">
        <Button size="icon-sm" variant="ghost" aria-label="Close node details" onClick={closeNodeInfo}>
          <ArrowLeft className="size-4" />
        </Button>
        <HardDrive className="size-4 text-flock-ink-muted" />
        <span className="text-md font-semibold tracking-tight">{node?.name ?? 'Node'}</span>
        {node ? (
          <>
            <Badge variant="neutral">{node.kind}</Badge>
            <Badge variant={STATUS_VARIANT[node.connectionStatus] ?? 'neutral'}>
              <span className="flock-status-dot" data-status={node.connectionStatus} />
              {node.connectionStatus}
            </Badge>
          </>
        ) : null}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
          {/* Live resource meters */}
          <div className="grid gap-3 sm:grid-cols-3">
            {info ? (
              <>
                <Meter
                  icon={Cpu}
                  label="CPU"
                  percent={Math.round(info.cpuPercent)}
                  value={`${Math.round(info.cpuPercent)}%`}
                />
                <Meter
                  icon={MemoryStick}
                  label="Memory"
                  percent={pct(info.memUsed, info.memTotal)}
                  value={`${formatGB(info.memUsed, true)} / ${formatGB(info.memTotal, true)}`}
                />
                <Meter
                  icon={HardDrive}
                  label="Disk"
                  percent={pct(info.diskUsed, info.diskTotal)}
                  value={`${formatGB(info.diskUsed, true)} / ${formatGB(info.diskTotal, true)}`}
                />
              </>
            ) : (
              <p className="col-span-3 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-4 text-sm text-flock-ink-muted">
                {isLoading ? 'Loading metrics…' : isError ? 'Could not reach this node’s daemon.' : '—'}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Connection">
              <Field label="Host" value={node?.host || (node?.kind === 'local' ? 'local socket' : '—')} />
              <Field label="Port" value={node?.port ? String(node.port) : '—'} />
              <Field label="SSH user" value={node?.sshUser || '—'} />
              <Field label="Last seen" value={fmtWhen(node?.lastSeenAt)} />
              <Field label="Added" value={fmtWhen(node?.createdAt)} />
            </Card>

            <Card title="Host">
              <Field label="Hostname" value={info?.hostname || '—'} />
              <Field label="OS" value={info?.os || '—'} />
              <Field label="Kernel" value={info?.kernel || '—'} />
              <Field label="Cores" value={info ? String(info.cores) : '—'} />
              <Field label="Memory" value={info ? formatGB(info.memTotal, true) : '—'} />
              <Field label="Disk" value={info ? formatGB(info.diskTotal, true) : '—'} />
              <Field label="Uptime" value={info ? fmtUptime(info.uptimeSec) : '—'} />
              <Field
                label="Load (1/5/15)"
                value={info ? `${info.load1.toFixed(2)} ${info.load5.toFixed(2)} ${info.load15.toFixed(2)}` : '—'}
              />
            </Card>
          </div>

          <Card title="Detected agents">
            {!info ? (
              <p className="text-sm text-flock-ink-muted">—</p>
            ) : info.agents.length === 0 ? (
              <p className="text-sm text-flock-ink-muted">No agent CLIs found.</p>
            ) : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {info.agents.map((a) => (
                  <li key={a.name} className="flex items-center gap-2 rounded-md bg-flock-surface-2 px-2.5 py-1.5 text-sm">
                    <span className="size-1.5 shrink-0 rounded-full bg-status-running" />
                    <span className="font-medium">{a.name}</span>
                    <span className="ml-auto truncate font-mono text-2xs text-flock-ink-muted" title={a.path}>
                      {a.version || a.path}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Sessions on this node (${nodeSessions.length})`}>
            {nodeSessions.length === 0 ? (
              <p className="text-sm text-flock-ink-muted">No active sessions.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {nodeSessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        selectSession(s.id);
                        closeNodeInfo();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-flock-surface-2"
                    >
                      <StatusDot status={liveStatuses.get(s.id) ?? s.status} className="shrink-0" />
                      <SquareTerminal className="size-3.5 shrink-0 text-flock-ink-muted" />
                      <span className="font-medium">{s.agentType}</span>
                      {info?.processes?.[s.id] ? (
                        <span
                          className="ml-auto shrink-0 tabular-nums text-2xs text-flock-ink-muted"
                          title="This session's process: resident memory · CPU% of the host"
                        >
                          {Math.round(info.processes[s.id]!.rssBytes / 1048576)} MB
                          {' · '}
                          {info.processes[s.id]!.cpuPct.toFixed(0)}% CPU
                        </span>
                      ) : null}
                      <code
                        className={`${info?.processes?.[s.id] != null ? '' : 'ml-auto '}rounded bg-flock-surface-2 px-1 py-0.5 text-2xs text-flock-ink-muted`}
                      >
                        {s.id.slice(0, 8)}
                      </code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}

export default NodePage;
