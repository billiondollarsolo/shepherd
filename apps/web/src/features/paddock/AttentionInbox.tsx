/**
 * AttentionInbox — a fleet-wide "who needs me" surface that lives in the TopBar,
 * so you can supervise every agent across every node without leaving the session
 * you're focused on. The bell badges the count of agents that need a human —
 * blocked (awaiting_input) or errored — and the dropdown lists them with
 * node · project context and jumps you straight into any one.
 *
 * This is the cross-agent inbox the local competitors lack: Herdr has a per-host
 * blocked sidebar, but Flock's is fleet-wide and always visible.
 */
import { Bell, AlertTriangle, MessageCircleQuestion, ListChecks } from 'lucide-react';
import { statusLabel, type Session, type Status } from '@flock/shared';
import { useNodes, useProjects, useSessions } from '../../data/queries';
import { useLiveStatuses } from './liveData';
import { usePaddock } from '../../store/paddock';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui';

/** Why an agent is in the inbox. plan/blocked (both awaiting) before error. */
export type AttentionReason = 'plan' | 'blocked' | 'error';
export interface AttentionItem {
  session: Session;
  reason: AttentionReason;
}
const RANK: Record<AttentionReason, number> = { plan: 0, blocked: 1, error: 2 };

/**
 * The fleet-wide attention list: open sessions that need a human — blocked or
 * errored by live status. A plan-mode agent that's awaiting is presenting a plan
 * for review (distinct from a plain question), so it gets its own 'plan' reason.
 * Pure so it's unit-testable without the Radix dropdown portal (won't mount in jsdom).
 */
export function attentionItems(
  sessions: readonly Session[],
  live: ReadonlyMap<string, Status>,
): AttentionItem[] {
  const statusOf = (s: Session): Status => live.get(s.id) ?? s.status;
  const items: AttentionItem[] = [];
  for (const s of sessions) {
    if (s.closedAt !== null) continue;
    const st = statusOf(s);
    if (st === 'awaiting_input') {
      items.push({ session: s, reason: s.permissionMode === 'plan' ? 'plan' : 'blocked' });
    } else if (st === 'error') items.push({ session: s, reason: 'error' });
  }
  return items.sort((a, b) => RANK[a.reason] - RANK[b.reason]);
}

const REASON_META: Record<AttentionReason, { icon: typeof Bell; color: string; label?: string }> = {
  plan: { icon: ListChecks, color: 'var(--flock-status-awaiting)', label: 'Plan ready' },
  blocked: { icon: MessageCircleQuestion, color: 'var(--flock-status-awaiting)' },
  error: { icon: AlertTriangle, color: 'var(--flock-status-error)' },
};

export function AttentionInbox(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const live = useLiveStatuses();
  const focusSession = usePaddock((s) => s.focusSession);

  const statusOf = (s: Session): Status => live.get(s.id) ?? s.status;
  const nodeName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? '—';
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '—';

  const items = attentionItems(sessions, live);
  const count = items.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `${count} agent${count === 1 ? '' : 's'} need you` : 'No agents need you'}
          title={count > 0 ? `${count} need you` : 'All caught up'}
          className={`relative flex size-8 items-center justify-center rounded-md hover:bg-flock-surface-2 ${
            count > 0 ? 'text-status-awaiting' : 'text-flock-ink-muted'
          }`}
        >
          <Bell className={`size-4 ${count > 0 ? 'animate-flock-pulse' : ''}`} />
          {count > 0 ? (
            <span
              data-testid="attention-badge"
              className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-status-awaiting px-1 text-[0.625rem] font-bold leading-4 text-white"
            >
              {count}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Needs you</span>
          <span className="text-2xs font-normal tabular-nums text-flock-ink-muted">{count}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {count === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-flock-ink-muted">All caught up.</div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {items.map(({ session: s, reason }) => {
              const meta = REASON_META[reason];
              const Icon = meta.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`attention-item-${s.id}`}
                  onClick={() => focusSession(s.id)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-flock-surface-2"
                >
                  <Icon className="size-4 shrink-0" style={{ color: meta.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-flock-ink-primary">
                      {s.agentType}
                    </span>
                    <span className="block truncate text-2xs text-flock-ink-muted">
                      {nodeName(s.nodeId)} · {projectName(s.projectId)}
                    </span>
                  </span>
                  <span className="shrink-0 text-2xs font-medium" style={{ color: meta.color }}>
                    {meta.label ?? statusLabel(statusOf(s))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
