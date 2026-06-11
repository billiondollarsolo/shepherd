/**
 * TerminalFleet — the Warp-style fleet lens: a command-bar on top, then one
 * grouped "block" per agent (status header + its latest output), mono-forward and
 * minimal. Click a block to drop into that agent. (fleetMode === 'terminal'.)
 */
import { useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { statusLabel, type Session, type Status } from '@flock/shared';
import { useNodes, useProjects, useSessions, useLatestChats } from '../../data/queries';
import { useLiveStatuses } from '../paddock/liveData';
import { usePaddock } from '../../store/paddock';
import { ScrollArea } from '../../components/ui';
import { ViewSwitcher } from './ViewSwitcher';

const statusColor = (s: Status): string =>
  `var(--flock-status-${s === 'awaiting_input' ? 'awaiting' : s})`;

function AgentBlock({
  session,
  status,
  nodeName,
  projectName,
  output,
  onFocus,
}: {
  session: Session;
  status: Status;
  nodeName: string;
  projectName: string;
  output?: string;
  onFocus: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onFocus}
      data-testid={`tf-block-${session.id}`}
      style={{ '--c': statusColor(status) } as React.CSSProperties}
      className="group w-full overflow-hidden rounded-lg border border-[var(--flock-border)] text-left ring-1 ring-white/[0.03] transition-colors hover:border-[var(--c)]"
    >
      {/* block header — agent · status · location */}
      <div className="flex items-center gap-2 border-b border-[var(--flock-border)] bg-flock-surface-1 px-3 py-1.5 font-mono text-xs">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: 'var(--c)' }} />
        <span className="font-semibold text-flock-ink-primary">{session.agentType}</span>
        <span className="truncate text-flock-ink-muted">
          {nodeName} · {projectName}
        </span>
        <span className="ml-auto shrink-0 font-medium" style={{ color: 'var(--c)' }}>
          {statusLabel(status)}
        </span>
      </div>
      {/* block body — latest message (the agent's chat feed, not raw PTY output) */}
      <div className="px-3 py-2 font-mono text-2xs leading-relaxed text-flock-ink-muted">
        {output ? (
          <span className="line-clamp-3 whitespace-pre-wrap text-flock-ink-primary/90">{output}</span>
        ) : (
          <span className="italic text-flock-ink-muted/60">no messages yet</span>
        )}
      </div>
    </button>
  );
}

export function TerminalFleet(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const { data: chats = {} } = useLatestChats();
  const live = useLiveStatuses();
  const focusSession = usePaddock((s) => s.focusSession);
  const openDialog = usePaddock((s) => s.openDialog);
  const [filter, setFilter] = useState('');

  const statusOf = (s: Session): Status => live.get(s.id) ?? s.status;
  const nodeName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? '—';
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '—';
  const open = useMemo(() => sessions.filter((s) => s.closedAt === null), [sessions]);
  const q = filter.trim().toLowerCase();
  const shown = open.filter(
    (s) => !q || s.agentType.toLowerCase().includes(q) || nodeName(s.nodeId).toLowerCase().includes(q),
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-flock-bg">
      <header className="flex flex-wrap items-center gap-3 px-6 pb-3 pt-6">
        <h1 className="font-display text-2xl font-bold tracking-tight text-flock-ink-primary">Paddock</h1>
        <span className="text-sm text-flock-ink-muted">
          {open.length} agent{open.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto">
          <ViewSwitcher />
        </div>
      </header>

      {/* command bar */}
      <div className="px-6 pb-3">
        <div className="flex items-center gap-2 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-3 py-2 font-mono text-sm focus-within:border-flock-accent">
          <span className="shrink-0 font-bold text-flock-accent">›</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter agents…  (⌘K to run a command)"
            className="min-w-0 flex-1 bg-transparent text-flock-ink-primary outline-none placeholder:text-flock-ink-muted/60"
          />
          <button
            type="button"
            onClick={() => openDialog('session')}
            className="shrink-0 rounded-md bg-flock-accent px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
          >
            + spawn
          </button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 px-6 pb-8">
          {shown.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <Bot className="size-7 text-flock-accent" />
              <p className="text-sm text-flock-ink-muted">
                {open.length === 0 ? 'No agents running.' : 'No agents match that filter.'}
              </p>
            </div>
          ) : (
            shown.map((s) => (
              <AgentBlock
                key={s.id}
                session={s}
                status={statusOf(s)}
                nodeName={nodeName(s.nodeId)}
                projectName={projectName(s.projectId)}
                output={chats[s.id]?.text}
                onFocus={() => focusSession(s.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
