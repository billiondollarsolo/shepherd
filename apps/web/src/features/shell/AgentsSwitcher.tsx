/**
 * Agents lens switcher — pin-first list with sort/filter (herdr Agents view).
 */
import { useMemo, useState } from 'react';
import {
  orderAgents,
  groupAgents,
  displayStatus,
  sessionInHostScope,
  type AgentSortKey,
  type AgentGroupKey,
  type AgentListItem,
  type Status,
} from '@flock/shared';
import { Pin } from 'lucide-react';
import { usePaddock } from '../../store/paddock';
import { useNodes, useProjects, useSessions, useUpdateSession } from '../../data/queries';
import { useLiveStatuses, useLiveStatusTransitions } from '../paddock/liveData';
import { StatusDot } from '../../components/StatusDot';

export function AgentsSwitcher(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const hostScope = usePaddock((s) => s.hostScope);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const openAgent = usePaddock((s) => s.openAgent);
  const statuses = useLiveStatuses();
  const transitions = useLiveStatusTransitions();
  const updateSession = useUpdateSession();

  const [sort, setSort] = useState<AgentSortKey>('attention');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [group, setGroup] = useState<AgentGroupKey>('none');

  const items = useMemo(() => {
    const open = sessions.filter((s) => s.closedAt === null);
    const scoped = open.filter((s) => sessionInHostScope(hostScope, s, nodes));
    const list: AgentListItem[] = scoped.map((s) => {
      const st = (statuses.get(s.id) ?? s.status) as Status;
      const node = nodes.find((n) => n.id === s.nodeId);
      const project = projects.find((p) => p.id === s.projectId);
      const lastMs = transitions.get(s.id) ?? (Date.parse(s.lastStatusAt) || 0);
      return {
        id: s.id,
        nodeId: s.nodeId,
        projectId: s.projectId,
        nodeName: node?.name,
        projectName: project?.name,
        pinned: s.pinned,
        status: st,
        lastStatusTransitionAt: lastMs,
        label: `${s.agentType} · ${s.id.slice(0, 6)}`,
      };
    });
    return orderAgents(list, { sort, pinnedOnly, activeOnly });
  }, [sessions, nodes, projects, hostScope, statuses, transitions, sort, pinnedOnly, activeOnly]);

  const groups = useMemo(() => groupAgents(items, group), [items, group]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-switcher">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--flock-border)] p-2">
        <select
          aria-label="Sort agents"
          className="rounded border border-[var(--flock-border)] bg-flock-surface-1 px-1.5 py-0.5 text-2xs"
          value={sort}
          onChange={(e) => setSort(e.target.value as AgentSortKey)}
        >
          <option value="attention">Attention</option>
          <option value="status">Status</option>
          <option value="lastStatusChange">Last change</option>
          <option value="project">Project</option>
          <option value="node">Node</option>
        </select>
        <select
          aria-label="Group agents"
          className="rounded border border-[var(--flock-border)] bg-flock-surface-1 px-1.5 py-0.5 text-2xs"
          value={group}
          onChange={(e) => setGroup(e.target.value as AgentGroupKey)}
        >
          <option value="none">No group</option>
          <option value="node">By node</option>
          <option value="project">By project</option>
          <option value="nodeProject">Node · project</option>
        </select>
        <label className="flex items-center gap-1 text-2xs text-flock-ink-muted">
          <input type="checkbox" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} />
          Pinned
        </label>
        <label className="flex items-center gap-1 text-2xs text-flock-ink-muted">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.key}>
            {group !== 'none' ? (
              <div className="px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-flock-ink-muted">
                {g.label}
              </div>
            ) : null}
            <ul className="flex flex-col">
              {g.items.map((item) => {
                // displayStatus was already exported; use .label (always set, incl. Idle).
                const disp = displayStatus(item.status);
                const active = item.id === selectedSessionId;
                const wordClass =
                  disp.kind === 'blocked'
                    ? 'font-semibold text-status-awaiting'
                    : disp.kind === 'error'
                      ? 'font-semibold text-status-error'
                      : disp.kind === 'working'
                        ? 'font-semibold text-flock-accent'
                        : disp.kind === 'disconnected'
                          ? 'font-medium text-status-disconnected'
                          : 'font-medium text-flock-ink-muted'; // Idle — affirmative, calm
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-testid={`agent-row-${item.id}`}
                      data-active={active ? '1' : '0'}
                      onClick={() => openAgent(item.id, item.projectId)}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-flock-surface-2 ${
                        active ? 'bg-flock-accent/10' : ''
                      }`}
                    >
                      <StatusDot status={item.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-flock-ink-primary">
                            {item.label}
                          </span>
                          {item.pinned ? <Pin className="size-3 shrink-0 text-flock-accent" /> : null}
                          <span
                            className={`shrink-0 text-2xs ${wordClass}`}
                            data-testid={`agent-status-word-${item.id}`}
                          >
                            {disp.label}
                          </span>
                        </div>
                        <div className="truncate text-2xs text-flock-ink-muted">
                          {[item.nodeName, item.projectName].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={item.pinned ? 'Unpin' : 'Pin'}
                        className="shrink-0 rounded p-1 text-flock-ink-muted hover:bg-flock-surface-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateSession.mutate({ id: item.id, patch: { pinned: !item.pinned } });
                        }}
                      >
                        <Pin className={`size-3.5 ${item.pinned ? 'text-flock-accent' : ''}`} />
                      </button>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {items.length === 0 ? (
          <div className="p-4 text-center text-sm text-flock-ink-muted">No agents in scope.</div>
        ) : null}
      </div>
    </div>
  );
}
