/**
 * ActivityFeed — a fleet-wide audit timeline in the TopBar: every agent's recent
 * status transitions in one chronological stream, click any row to jump to that
 * agent. Where the AttentionInbox answers "who needs me right now", this answers
 * "what has the fleet been doing" — a cross-agent audit log no surveyed competitor
 * ships (#1d). Data: GET /api/activity/fleet (the persisted event log).
 */
import { History } from 'lucide-react';
import { statusLabel, type Event, type Status } from '@flock/shared';
import { useFleetActivity, useNodes, useProjects, useSessions } from '../../data/queries';
import { usePaddock } from '../../store/paddock';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui';

/** Compact relative time: "now", "3m", "2h", "4d". Pure. */
export function timeAgo(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function ActivityFeed(): JSX.Element {
  const openAgent = usePaddock((s) => s.openAgent);
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  // Only poll while the popover concept is cheap — the query itself backstops at 8s.
  const { data: events = [] } = useFleetActivity();

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const nodeName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? '—';
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '—';
  const now = Date.now();

  const label = (ev: Event): { agent: string; where: string } => {
    const s = sessionById.get(ev.sessionId);
    if (!s) return { agent: 'agent', where: '' };
    return { agent: s.agentType, where: `${nodeName(s.nodeId)} · ${projectName(s.projectId)}` };
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Fleet activity"
          title="Fleet activity"
          className="flex size-8 items-center justify-center rounded-md text-flock-ink-muted hover:bg-flock-surface-2"
        >
          <History className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuLabel>Fleet activity</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {events.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-flock-ink-muted">No activity yet.</div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto py-1">
            {events.map((ev) => {
              const { agent, where } = label(ev);
              return (
                <button
                  key={ev.id}
                  type="button"
                  data-testid={`activity-item-${ev.id}`}
                  onClick={() => openAgent(ev.sessionId)}
                  className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-flock-surface-2"
                >
                  <span
                    className="mt-1 flock-status-dot shrink-0"
                    data-status={ev.mappedStatus ?? 'disconnected'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-xs font-semibold text-flock-ink-primary">
                        {agent}
                      </span>
                      {ev.mappedStatus ? (
                        <span className="shrink-0 text-2xs text-flock-ink-muted">
                          {statusLabel(ev.mappedStatus as Status)}
                        </span>
                      ) : null}
                    </span>
                    {ev.detail ? (
                      <span className="block truncate text-2xs text-flock-ink-muted">
                        {ev.detail}
                      </span>
                    ) : null}
                    {where ? (
                      <span className="block truncate text-2xs text-flock-ink-muted/70">
                        {where}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-flock-ink-muted/70">
                    {timeAgo(ev.ts, now)}
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
