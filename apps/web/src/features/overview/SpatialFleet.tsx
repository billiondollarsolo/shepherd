/**
 * SpatialFleet — the fleet as TOPOLOGY: each node is a container, the projects on
 * it are sub-groups, and the agents live inside those. This makes the multi-node
 * moat legible at a glance (where every agent physically runs), which a flat graph
 * didn't. Lead agents (those that spawned others via spawn/handoff edges) are
 * marked with a network glyph. Click any agent to drop into it. (fleetMode === 'spatial'.)
 */
import { useMemo } from 'react';
import { Bot, FolderGit2, HardDrive, Network } from 'lucide-react';
import { statusLabel, type GitStatusResponse, type Session, type Status } from '@flock/shared';
import { useSessions, useTeams, useNodes, useProjects, useFleetGit } from '../../data/queries';
import { useAgentdHealth, useLiveStatuses } from '../paddock/liveData';
import { ContextMeter } from '../paddock/ContextMeter';
import { GitBadge } from '../paddock/GitBadge';
import { usePaddock } from '../../store/paddock';
import { ScrollArea } from '../../components/ui';
import { ViewSwitcher } from './ViewSwitcher';

const statusColor = (s: Status): string =>
  `var(--flock-status-${s === 'awaiting_input' ? 'awaiting' : s})`;

/** The context-fullness telemetry an agent may report (subset of agentd-health). */
interface NodeSpend {
  contextPct?: number;
  contextTokens?: number;
  contextLimit?: number;
}

/** One agent inside a node→project container. */
function AgentCard({
  session,
  status,
  spend,
  git,
  lead,
  onFocus,
}: {
  session: Session;
  status: Status;
  spend?: NodeSpend;
  git?: GitStatusResponse | null;
  lead?: boolean;
  onFocus: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onFocus}
      data-testid={`sf-node-${session.id}`}
      style={{ '--c': statusColor(status) } as React.CSSProperties}
      className={`group relative flex w-36 flex-col items-center gap-1 rounded-lg border bg-flock-surface-0 p-2.5 text-center transition-all hover:-translate-y-0.5 hover:border-[var(--c)] ${
        status === 'awaiting_input' ? 'border-[var(--c)] animate-flock-pulse' : 'border-[var(--flock-border)]'
      }`}
      title={`${session.agentType} — ${statusLabel(status)}${lead ? ' (lead)' : ''}`}
    >
      <span
        className="flex size-8 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--c) 18%, transparent)', color: 'var(--c)' }}
      >
        {lead ? <Network className="size-4" /> : <Bot className="size-4" />}
      </span>
      <span className="max-w-full truncate text-xs font-semibold text-flock-ink-primary">{session.agentType}</span>
      <span className="flex items-center gap-1 text-2xs" style={{ color: 'var(--c)' }}>
        <span className="size-1.5 rounded-full" style={{ background: 'var(--c)' }} />
        {statusLabel(status)}
      </span>
      {spend?.contextPct != null ? (
        <ContextMeter pct={spend.contextPct} tokens={spend.contextTokens} limit={spend.contextLimit} />
      ) : null}
      <GitBadge git={git} />
    </button>
  );
}

const CONN_DOT: Record<string, string> = {
  connected: 'bg-status-idle',
  connecting: 'bg-status-running',
  error: 'bg-status-error',
  disconnected: 'bg-status-disconnected',
};

export function SpatialFleet(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: edges = [] } = useTeams();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const live = useLiveStatuses();
  const health = useAgentdHealth();
  const focusSession = usePaddock((s) => s.focusSession);
  const openDialog = usePaddock((s) => s.openDialog);
  const spendOf = (id: string): NodeSpend | undefined => health?.sessions[id];

  const statusOf = (s: Session): Status => live.get(s.id) ?? s.status;
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'project';
  const open = useMemo(() => sessions.filter((s) => s.closedAt === null), [sessions]);
  const fleetGit = useFleetGit(useMemo(() => open.map((s) => s.id), [open]));

  // Agents that spawned others (spawn/handoff edges) → marked as leads.
  const leadIds = useMemo(() => {
    const ids = new Set<string>();
    const live = new Set(open.map((s) => s.id));
    for (const e of edges) if (live.has(e.parent) && live.has(e.child)) ids.add(e.parent);
    return ids;
  }, [edges, open]);

  // node id → (project id → its open sessions).
  const byNode = useMemo(() => {
    const m = new Map<string, Map<string, Session[]>>();
    for (const s of open) {
      const proj = m.get(s.nodeId) ?? m.set(s.nodeId, new Map()).get(s.nodeId)!;
      (proj.get(s.projectId) ?? proj.set(s.projectId, []).get(s.projectId)!).push(s);
    }
    return m;
  }, [open]);

  // Show a container for every node that has agents OR is connected (so you see
  // capacity to place onto), busiest first then by name.
  const shownNodes = useMemo(
    () =>
      nodes
        .filter((n) => byNode.has(n.id) || n.connectionStatus === 'connected')
        .sort((a, b) => (byNode.get(b.id)?.size ?? 0) - (byNode.get(a.id)?.size ?? 0) || a.name.localeCompare(b.name)),
    [nodes, byNode],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-flock-bg">
      <header className="relative flex flex-wrap items-center gap-3 px-6 py-3.5">
        <span className="text-xs font-medium uppercase tracking-label text-flock-ink-muted">Flock topology</span>
        <div className="ml-auto flex items-center gap-2.5">
          <ViewSwitcher />
          <button
            type="button"
            onClick={() => openDialog('session')}
            className="flex items-center gap-1.5 rounded-lg bg-flock-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-flock-accent/90"
          >
            <Bot className="size-4" /> New agent
          </button>
        </div>
      </header>

      <ScrollArea className="relative min-h-0 flex-1">
        {open.length === 0 ? (
          <div className="flex w-full flex-col items-center justify-center gap-3 py-24 text-center">
            <Network className="size-7 text-flock-accent" />
            <p className="text-sm text-flock-ink-muted">No agents yet — spawn one to see the fleet.</p>
          </div>
        ) : (
          <div className="grid gap-5 px-6 py-6 [grid-template-columns:repeat(auto-fill,minmax(24rem,1fr))]">
            {shownNodes.map((node) => {
              const projGroups = [...(byNode.get(node.id)?.entries() ?? [])].sort((a, b) =>
                projectName(a[0]).localeCompare(projectName(b[0])),
              );
              const agentCount = projGroups.reduce((n, [, ss]) => n + ss.length, 0);
              return (
                <section
                  key={node.id}
                  data-testid={`sf-node-container-${node.id}`}
                  className="flex flex-col gap-3 rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4"
                >
                  {/* node header */}
                  <div className="flex items-center gap-2">
                    <HardDrive className="size-4 shrink-0 text-flock-ink-muted" />
                    <span className="truncate text-sm font-semibold text-flock-ink-primary">{node.name}</span>
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${CONN_DOT[node.connectionStatus] ?? 'bg-status-disconnected'}`}
                      title={node.connectionStatus}
                    />
                    {node.pool ? (
                      <span className="shrink-0 rounded-full bg-flock-surface-3 px-1.5 text-[0.625rem] font-medium text-flock-ink-muted">
                        {node.pool}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 rounded-full bg-flock-surface-2 px-1.5 text-2xs tabular-nums text-flock-ink-muted">
                      {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
                    </span>
                  </div>

                  {/* projects on this node */}
                  {projGroups.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-[var(--flock-border)] px-3 py-4 text-center text-2xs text-flock-ink-muted">
                      No agents — connected and ready.
                    </p>
                  ) : (
                    projGroups.map(([projectId, projSessions]) => (
                      <div key={projectId} className="rounded-lg bg-flock-surface-0/40 p-2.5">
                        <div className="mb-2 flex items-center gap-1.5 px-0.5">
                          <FolderGit2 className="size-3.5 shrink-0 text-flock-ink-muted" />
                          <span className="truncate text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
                            {projectName(projectId)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2.5">
                          {projSessions.map((s) => (
                            <AgentCard
                              key={s.id}
                              session={s}
                              status={statusOf(s)}
                              spend={spendOf(s.id)}
                              git={fleetGit.get(s.id)}
                              lead={leadIds.has(s.id)}
                              onFocus={() => focusSession(s.id)}
                            />
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </section>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
