/** Operational node dashboard: metrics → projects/Git/agents → host details. */
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Cpu,
  FolderGit2,
  GitBranch,
  Gauge,
  HardDrive,
  MemoryStick,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
} from 'lucide-react';
import { displayStatus, type NodeInfo } from '@flock/shared';
import type { LucideIcon } from 'lucide-react';
import type { BadgeProps } from '../../components/ui';
import { Badge, Button, ScrollArea } from '../../components/ui';
import { useFleetGit, useNodeInfo, useNodes, useProjects, useSessions } from '../../data/queries';
import type { AgentdHealth } from '../../data/treeApi';
import { usePaddock } from '../../store/paddock';
import { formatGB } from '../../lib/utils';
import { useAgentdHealth, useLiveStatuses } from './liveData';
import { StatusDot } from '../../components/StatusDot';
import { ProjectPolicyEditor } from './ProjectPolicyEditor';

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
    <div className="flex min-h-28 flex-col rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4">
      <div className="flex items-center gap-2 text-sm">
        <Icon className="size-4 text-flock-ink-muted" />
        <span className="font-medium text-flock-ink-primary">{label}</span>
      </div>
      <span className="mt-3 text-xl font-semibold tabular-nums text-flock-ink-primary">
        {value}
      </span>
      <div className="mt-auto h-1.5 overflow-hidden rounded-full bg-flock-surface-3">
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
    <section className="rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-label text-flock-ink-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ControlPlaneCard({
  control,
  failure,
}: {
  control: NodeInfo['control'];
  failure: AgentdHealth['nodes'][string]['failure'];
}): JSX.Element {
  if (!control) {
    return (
      <Card title="Control plane">
        {failure ? (
          <div className="space-y-2">
            <Badge variant="danger">{failure.code}</Badge>
            <p className="text-sm text-flock-ink-primary">{failure.message}</p>
            <p className="text-2xs text-flock-ink-muted">Last failure {fmtWhen(failure.at)}</p>
          </div>
        ) : (
          <p className="text-sm text-flock-ink-muted">
            Control diagnostics are unavailable. The daemon may need an upgrade.
          </p>
        )}
      </Card>
    );
  }

  const secure = control.mode === 'secure';
  const anomalies = control.authFailures + control.malformedFrames + control.writeTimeouts;
  return (
    <Card title="Control plane">
      <div className="mb-2 flex items-center gap-2">
        {secure ? (
          <ShieldCheck className="size-4 text-status-running" aria-hidden="true" />
        ) : (
          <ShieldAlert className="size-4 text-status-error" aria-hidden="true" />
        )}
        <Badge variant={secure ? 'success' : 'danger'}>
          {secure ? 'Secure' : 'Insecure development'}
        </Badge>
        {anomalies > 0 ? (
          <Badge variant="danger" className="ml-auto">
            {anomalies} anomalies
          </Badge>
        ) : null}
      </div>
      <Field label="Daemon" value={control.daemonVersion} />
      <Field label="Protocol" value={`v${control.protocol}`} />
      <Field label="Connections" value={String(control.connections)} />
      <Field label="Sessions opened" value={String(control.sessionsOpened)} />
      <Field label="Sessions closed" value={String(control.sessionsClosed)} />
      <Field label="Credential rotations" value={String(control.credentialRotations)} />
      <Field label="Dropped output" value={`${control.droppedOutputBytes} bytes`} />
      {anomalies > 0 ? (
        <div className="mt-2 border-t border-[var(--flock-border)] pt-2">
          <Field label="Authentication failures" value={String(control.authFailures)} />
          <Field label="Malformed frames" value={String(control.malformedFrames)} />
          <Field label="Write timeouts" value={String(control.writeTimeouts)} />
        </div>
      ) : null}
    </Card>
  );
}

export function NodePage(): JSX.Element {
  const nodeId = usePaddock((s) => s.nodeInfoNodeId);
  const openMission = usePaddock((s) => s.openMission);
  const openAgent = usePaddock((s) => s.openAgent);
  const selectProject = usePaddock((s) => s.selectProject);
  const openProjectGit = usePaddock((s) => s.openProjectGit);
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useSessions();
  const node = nodes.find((candidate) => candidate.id === nodeId) ?? null;
  const { data: info, isLoading, isError } = useNodeInfo(nodeId);
  const nodeSessions = sessions.filter(
    (session) => session.nodeId === nodeId && session.closedAt === null,
  );
  const nodeProjects = projects.filter((project) => project.nodeId === nodeId);
  const gitBySession = useFleetGit(nodeSessions.map((session) => session.id));
  const liveStatuses = useLiveStatuses();
  const agentdHealth = useAgentdHealth();

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-flock-surface-0 text-flock-ink-primary">
      <header className="flex h-topbar min-w-0 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3 sm:gap-3 sm:px-4">
        <Button size="icon-sm" variant="ghost" aria-label="Back to Paddock" onClick={openMission}>
          <ArrowLeft className="size-4" />
        </Button>
        <HardDrive className="hidden size-4 shrink-0 text-flock-ink-muted sm:block" />
        <span className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight">
          {node?.name ?? 'Node'}
        </span>
        {node ? (
          <>
            <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">
              {node.kind}
            </Badge>
            <Badge variant={STATUS_VARIANT[node.connectionStatus] ?? 'neutral'}>
              <span className="flock-status-dot" data-status={node.connectionStatus} />
              {node.connectionStatus}
            </Badge>
          </>
        ) : null}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-flock-ink-primary">Node health</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
                    label="Storage"
                    percent={pct(info.diskUsed, info.diskTotal)}
                    value={`${formatGB(info.diskUsed, true)} / ${formatGB(info.diskTotal, true)}`}
                  />
                  <div className="flex min-h-28 flex-col rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4">
                    <div className="flex items-center gap-2 text-sm">
                      <Gauge className="size-4 text-flock-ink-muted" />
                      <span className="font-medium">Load & uptime</span>
                    </div>
                    <span className="mt-3 text-xl font-semibold tabular-nums">
                      {info.load1.toFixed(2)}
                    </span>
                    <span className="mt-auto text-2xs text-flock-ink-muted">
                      {info.cores} cores · up {fmtUptime(info.uptimeSec)}
                    </span>
                  </div>
                </>
              ) : (
                <p className="col-span-full rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4 text-sm text-flock-ink-muted">
                  {isLoading
                    ? 'Loading metrics…'
                    : isError
                      ? 'Could not reach this node’s daemon.'
                      : '—'}
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-flock-ink-primary">Projects</h2>
              <span className="text-xs text-flock-ink-muted">
                {nodeProjects.length} on this node
              </span>
            </div>
            {nodeProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--flock-border)] p-8 text-center text-sm text-flock-ink-muted">
                No projects on this node.
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {nodeProjects.map((project) => {
                  const projectSessions = nodeSessions.filter(
                    (session) => session.projectId === project.id,
                  );
                  const gitSession = projectSessions.find((session) =>
                    gitBySession.has(session.id),
                  );
                  const git = gitSession ? gitBySession.get(gitSession.id) : undefined;
                  return (
                    <article
                      key={project.id}
                      className="overflow-hidden rounded-xl border border-[var(--flock-border)] bg-flock-surface-1"
                    >
                      <div className="flex items-start gap-3 p-4">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-flock-surface-2 text-flock-ink-muted">
                          <FolderGit2 className="size-4" />
                        </span>
                        <button
                          type="button"
                          onClick={() => selectProject(project.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-base font-semibold hover:text-flock-accent">
                            {project.name}
                          </span>
                          <span className="block truncate font-mono text-2xs text-flock-ink-muted">
                            {project.workingDir}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={!gitSession}
                          onClick={() => openProjectGit(project.id)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--flock-border)] bg-flock-surface-0 px-2 py-1.5 text-xs text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary disabled:opacity-50"
                          aria-label={`Open ${project.name} source control`}
                        >
                          <GitBranch className="size-3.5" /> {git?.branch ?? 'Git'}
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--flock-border)] bg-flock-surface-0 px-4 py-2 font-mono text-2xs text-flock-ink-muted">
                        <ProjectPolicyEditor project={project} />
                        {git ? (
                          <>
                            <span className={git.files.length ? 'text-status-awaiting' : ''}>
                              {git.files.length ? `${git.files.length} changed` : 'Clean'}
                            </span>
                            {git.ahead ? (
                              <span className="inline-flex items-center gap-0.5">
                                <ArrowUp className="size-3" /> {git.ahead}
                              </span>
                            ) : null}
                            {git.behind ? (
                              <span className="inline-flex items-center gap-0.5">
                                <ArrowDown className="size-3" /> {git.behind}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span>Git status unavailable</span>
                        )}
                      </div>

                      <div>
                        {projectSessions.map((session) => {
                          const status = liveStatuses.get(session.id) ?? session.status;
                          const process = info?.processes?.[session.id];
                          return (
                            <button
                              key={session.id}
                              type="button"
                              onClick={() => openAgent(session.id, project.id)}
                              className="flex w-full items-center gap-2 border-b border-[var(--flock-border)] px-4 py-2.5 text-left last:border-b-0 hover:bg-flock-surface-2"
                            >
                              <StatusDot status={status} className="shrink-0" />
                              <SquareTerminal className="size-3.5 shrink-0 text-flock-ink-muted" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {session.note?.trim() || session.agentType}
                                </span>
                                <span className="block truncate text-2xs text-flock-ink-muted">
                                  {displayStatus(status).label} · {session.id.slice(0, 8)}
                                </span>
                              </span>
                              {process ? (
                                <span className="shrink-0 text-right text-2xs tabular-nums text-flock-ink-muted">
                                  {Math.round(process.rssBytes / 1048576)} MB
                                  <br />
                                  {process.cpuPct.toFixed(0)}% CPU
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                        {projectSessions.length === 0 ? (
                          <p className="px-4 py-3 text-xs text-flock-ink-muted">
                            No active agents.
                          </p>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card title="Connection">
              <Field
                label="Host"
                value={node?.host || (node?.kind === 'local' ? 'local socket' : '—')}
              />
              <Field label="Port" value={node?.port ? String(node.port) : '—'} />
              <Field label="SSH user" value={node?.sshUser || '—'} />
              <Field label="Last seen" value={fmtWhen(node?.lastSeenAt)} />
              <Field label="Added" value={fmtWhen(node?.createdAt)} />
            </Card>

            <Card title="Host">
              <Field label="Hostname" value={info?.hostname || '—'} />
              <Field label="OS" value={info?.os || '—'} />
              <Field label="Kernel" value={info?.kernel || '—'} />
              <Field
                label="Load 1/5/15"
                value={
                  info
                    ? `${info.load1.toFixed(2)} ${info.load5.toFixed(2)} ${info.load15.toFixed(2)}`
                    : '—'
                }
              />
            </Card>

            <ControlPlaneCard
              control={info?.control}
              failure={nodeId ? agentdHealth?.nodes[nodeId]?.failure : undefined}
            />

            <Card title="Detected agent CLIs">
              {!info || info.agents.length === 0 ? (
                <p className="text-sm text-flock-ink-muted">No agent CLIs found.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {info.agents.map((agent) => (
                    <li
                      key={agent.name}
                      className="flex items-center gap-2 rounded-md bg-flock-surface-2 px-2.5 py-1.5 text-sm"
                    >
                      <span className="size-1.5 shrink-0 rounded-full bg-status-running" />
                      <span className="font-medium">{agent.name}</span>
                      <span
                        className="ml-auto truncate font-mono text-2xs text-flock-ink-muted"
                        title={agent.path}
                      >
                        {agent.version || agent.path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
