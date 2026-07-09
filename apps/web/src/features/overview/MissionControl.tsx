/**
 * Paddock — the fleet-first HOME (redesign #98). You land here: every
 * agent across every node at a glance, with the ones that NEED YOU pulled into a
 * hero band up top. Bold, status-forward design language (#100): status drives
 * colour + motion; click any agent to drop into its workspace.
 */
import { useCallback, useMemo, type CSSProperties } from 'react';
import { Bot, Check, FolderGit2, GitBranch, HardDrive, Layers, Network } from 'lucide-react';
import { ViewSwitcher } from './ViewSwitcher';
import {
  filterSessionsByHostScope,
  statusLabel,
  type GitStatusResponse,
  type Session,
  type Status,
} from '@flock/shared';
import {
  useNodes,
  useProjects,
  useSessions,
  useLatestChats,
  useTeams,
  useFleetGit,
  useUpdateSession,
} from '../../data/queries';
import { useAgentdHealth, useLiveStatuses } from '../paddock/liveData';
import { ContextMeter } from '../paddock/ContextMeter';
import { GitBadge, changedCount } from '../paddock/GitBadge';
import { usePaddock } from '../../store/paddock';
import { StatusDot } from '../../components/StatusDot';
import { formatCostUsd, formatTokens, isShellProcess } from '../../lib/utils';

const STATUS_ORDER: Record<string, number> = {
  awaiting_input: 0,
  error: 1,
  running: 2,
  starting: 3,
  idle: 4,
  done: 5,
  disconnected: 6,
};

/** Status → accent color (status-driven design language). */
function accent(status: Status): string {
  switch (status) {
    case 'awaiting_input':
      return 'var(--flock-status-awaiting)';
    case 'error':
      return 'var(--flock-status-error)';
    case 'running':
      return 'var(--flock-status-running)';
    case 'starting':
      return 'var(--flock-status-starting)';
    case 'done':
      return 'var(--flock-status-done)';
    default:
      return 'var(--flock-status-idle)';
  }
}

interface CardMeta {
  tool?: string;
  model?: string;
  contextPct?: number | null;
  contextTokens?: number;
  contextLimit?: number;
  tokens?: number;
  costUsd?: number | null;
}

/**
 * One fleet card. Top-level (stable identity) so it doesn't remount each render.
 * Its latest message (`chat`) comes from ONE batch query in the parent — so the
 * whole fleet is a live activity feed (what each agent is asking/doing) with no
 * per-card fetch. Chat where it earns its keep: supervising agents you're not
 * driving, not a redundant mirror of a session you're live in.
 */
function MissionCard({
  session,
  status,
  accentColor,
  nodeName,
  projectName,
  meta,
  git,
  chat,
  onFocus,
  onReview,
  onReviewed,
}: {
  session: Session;
  status: Status;
  accentColor: string;
  nodeName: string;
  projectName: string;
  meta?: CardMeta;
  git?: GitStatusResponse | null;
  chat?: { role: string; text: string };
  onFocus: () => void;
  onReview?: () => void;
  onReviewed?: () => void;
}): JSX.Element {
  const attention = status === 'awaiting_input';
  // Show the latest message on active agents (the question / what it's doing) AND on
  // "ready to review" cards (what it produced) — the at-a-glance fleet feed.
  const active = attention || status === 'running';
  const ask = active || onReview ? (chat?.text ?? '') : '';
  const u = meta;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${session.agentType} on ${nodeName} · ${projectName} — ${statusLabel(status)}`}
      data-testid={`mc-card-${session.id}`}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
      style={{ '--c': accentColor } as CSSProperties}
      className={`group relative flex cursor-pointer flex-col gap-2 overflow-hidden rounded-xl border bg-flock-surface-1 p-4 text-left transition-colors duration-150 ${
        attention
          ? 'border-[var(--c)] animate-flock-pulse'
          : 'border-[var(--flock-border)] hover:border-[var(--c)]'
      }`}
    >
      {/* top sheen for depth */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/10" />
      <div className="flex items-center gap-2 pl-1">
        <StatusDot status={status} pulse={attention} />
        <span className="truncate font-semibold text-flock-ink-primary">{session.agentType}</span>
        <span
          className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium"
          style={{ background: 'color-mix(in srgb, var(--c) 16%, transparent)', color: 'var(--c)' }}
        >
          {statusLabel(status)}
        </span>
      </div>
      <div className="flex items-center gap-1 truncate pl-1 text-2xs text-flock-ink-muted">
        <span className="truncate">{nodeName}</span>
        <span>·</span>
        <span className="truncate">{projectName}</span>
      </div>
      {ask ? (
        <p
          className="pl-1 text-2xs italic leading-snug text-flock-ink-primary/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden"
          title={ask}
        >
          “{ask}”
        </p>
      ) : u?.tool && !isShellProcess(u.tool) ? (
        <div className="truncate pl-1 text-2xs text-flock-ink-muted/80" title={u.tool}>
          {u.tool}
        </div>
      ) : null}
      <div className="mt-auto flex items-center gap-2 pl-1 text-2xs tabular-nums text-flock-ink-muted/70">
        {u?.model ? <span className="max-w-[8rem] truncate">{u.model}</span> : null}
        {u?.contextPct != null ? (
          <ContextMeter pct={u.contextPct} tokens={u.contextTokens} limit={u.contextLimit} />
        ) : null}
        {u?.tokens ? <span>{formatTokens(u.tokens)} tok</span> : null}
        {u?.costUsd != null ? <span>{formatCostUsd(u.costUsd)}</span> : null}
        <GitBadge git={git} className="ml-auto" />
      </div>
      {onReview ? (
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            data-testid={`mc-review-${session.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onReview();
            }}
            className="flex flex-1 items-center justify-center gap-1 rounded-md bg-flock-accent/15 py-1 text-2xs font-semibold text-flock-accent hover:bg-flock-accent/25"
          >
            Review changes →
          </button>
          {onReviewed ? (
            <button
              type="button"
              data-testid={`mc-reviewed-${session.id}`}
              title="Mark reviewed"
              onClick={(e) => {
                e.stopPropagation();
                onReviewed();
              }}
              className="flex shrink-0 items-center gap-1 rounded-md bg-flock-surface-2 px-2 py-1 text-2xs font-semibold text-flock-ink-muted hover:bg-status-idle/20 hover:text-status-idle"
            >
              <Check className="size-3" /> Reviewed
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MissionControl(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const live = useLiveStatuses();
  const health = useAgentdHealth();
  const { data: latestChats = {} } = useLatestChats();
  const { data: edges = [] } = useTeams();
  const reviewed = usePaddock((s) => s.reviewedSessions);
  const setReviewed = usePaddock((s) => s.setReviewed);
  const updateSession = useUpdateSession();
  // Persist reviewed server-side (durable across devices/restarts) AND flip the
  // store optimistically so the card leaves "Ready to review" instantly.
  const markReviewed = (id: string): void => {
    setReviewed(id, true);
    updateSession.mutate({ id, patch: { reviewed: true } });
  };
  const openAgent = usePaddock((s) => s.openAgent);
  const openDialog = usePaddock((s) => s.openDialog);
  const openRight = usePaddock((s) => s.openRight);
  /** D2: always pass projectId so stage layout scopes correctly. */
  const openSession = useCallback(
    (s: Session): void => {
      openAgent(s.id, s.projectId);
    },
    [openAgent],
  );
  // Jump straight to an agent's CHANGES (the work product) — the Review action.
  const review_ = (s: Session): void => {
    openSession(s);
    openRight('diff');
  };

  const statusOf = (s: Session): Status => live.get(s.id) ?? s.status;
  const hostScope = usePaddock((s) => s.hostScope);
  // Host chips scope the paddock home (not only the Agents list).
  const open = useMemo(
    () => filterSessionsByHostScope(sessions, hostScope, nodes),
    [sessions, hostScope, nodes],
  );
  // Fleet-wide git (shares the per-session cache) → card badges + the changes lane.
  const openIds = useMemo(() => open.map((s) => s.id), [open]);
  const fleetGit = useFleetGit(openIds);
  const sorted = useMemo(
    () => [...open].sort((a, b) => (STATUS_ORDER[statusOf(a)] ?? 9) - (STATUS_ORDER[statusOf(b)] ?? 9)),
    [open, live],
  );
  const byId = useMemo(() => new Map(open.map((s) => [s.id, s])), [open]);
  // Sessions shown as children under the Teams section are EXCLUDED from the fleet
  // groups below so a spawned agent never appears twice (a child pill AND a card).
  const childIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) if (byId.has(e.parent) && byId.has(e.child)) s.add(e.child);
    return s;
  }, [edges, byId]);
  const inFleet = (s: Session): boolean => !childIds.has(s.id);
  // Group by what you need to DO (outcome-centric), not just status. "Ready to
  // review" = a finished agent that actually produced work (has a message).
  const isActive = (s: Session): boolean => {
    const st = statusOf(s);
    return st === 'running' || st === 'starting';
  };
  const isDone = (s: Session): boolean => {
    const st = statusOf(s);
    return st === 'idle' || st === 'done';
  };
  // Server-durable reviewed state (reviewedAt) UNION the optimistic store overlay,
  // so it's consistent across devices/restarts but still flips instantly on click.
  const reviewedSet = useMemo(() => {
    const set = new Set(reviewed);
    for (const s of open) if (s.reviewedAt) set.add(s.id);
    return set;
  }, [reviewed, open]);
  const needs = sorted.filter((s) => statusOf(s) === 'awaiting_input' && inFleet(s));
  const working = sorted.filter((s) => isActive(s) && inFleet(s));
  // "Ready to review" = a finished agent that produced work AND you haven't reviewed yet.
  const review = sorted.filter(
    (s) => isDone(s) && !!latestChats[s.id]?.text && !reviewedSet.has(s.id) && inFleet(s),
  );
  const reviewIds = new Set(review.map((s) => s.id));
  // Everything else done (no message OR already reviewed) is calm/idle.
  const quiet = sorted.filter((s) => isDone(s) && inFleet(s) && !reviewIds.has(s.id));
  const nodeName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? '—';
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '—';
  // Agents with uncommitted work — a triage lane so review is front-and-center
  // (not buried in the Source Control panel). Compact rows, separate from the cards.
  const changed = sorted.filter((s) => inFleet(s) && changedCount(fleetGit.get(s.id)) > 0);

  // Collaboration graph: which agent spawned which (the orchestration hero). Build
  // parent → children among OPEN sessions; roots are leads that aren't themselves
  // a spawned child.
  const teams = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const e of edges) {
      if (!byId.has(e.parent) || !byId.has(e.child)) continue;
      (kids.get(e.parent) ?? kids.set(e.parent, []).get(e.parent)!).push(e.child);
    }
    return [...kids.keys()]
      .filter((p) => !childIds.has(p)) // roots = leads that aren't themselves children
      .map((rootId) => ({ lead: byId.get(rootId)!, children: (kids.get(rootId) ?? []).map((id) => byId.get(id)!).filter(Boolean) }));
  }, [edges, byId, childIds]);
  // A "calm" fleet (nothing demanding attention) → invite action with quick-start
  // so the home is never an empty void.
  const calm = needs.length === 0 && review.length === 0 && working.length === 0 && teams.length === 0;
  const quickStart: ReadonlyArray<{ icon: typeof Bot; label: string; hint: string; onClick: () => void; primary?: boolean }> = [
    { icon: Bot, label: 'Spawn an agent', hint: 'Put a coding agent to work', onClick: () => openDialog('session'), primary: true },
    { icon: FolderGit2, label: 'New project', hint: 'Add a repo to work in', onClick: () => openDialog('project') },
    { icon: HardDrive, label: 'Add a node', hint: 'Connect another machine', onClick: () => openDialog('node') },
  ];

  const renderCard = (s: Session, opts?: { review?: boolean }): JSX.Element => (
    <MissionCard
      key={s.id}
      session={s}
      status={statusOf(s)}
      accentColor={accent(statusOf(s))}
      nodeName={nodeName(s.nodeId)}
      projectName={projectName(s.projectId)}
      meta={health?.sessions[s.id]}
      git={fleetGit.get(s.id)}
      chat={latestChats[s.id]}
      onFocus={() => openSession(s)}
      onReview={opts?.review ? () => review_(s) : undefined}
      onReviewed={opts?.review ? () => markReviewed(s.id) : undefined}
    />
  );

  return (
    <div
      data-testid="mission-control"
      className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-flock-bg"
    >
      <header className="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3.5">
        {/* needs-you — the one count that should pull the eye */}
        <span
          data-testid="mc-needs-you"
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            needs.length > 0
              ? 'bg-status-awaiting/15 text-status-awaiting ring-1 ring-status-awaiting/30 animate-flock-pulse'
              : 'border border-[var(--flock-border)] bg-flock-surface-1 text-flock-ink-muted'
          }`}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ background: needs.length > 0 ? 'var(--flock-status-awaiting)' : 'var(--flock-ink-muted)' }}
          />
          {needs.length} need{needs.length === 1 ? 's' : ''} you
        </span>

        {/* the rest of the fleet at a glance */}
        {[
          { label: 'to review', value: review.length, color: 'var(--flock-status-running)' },
          { label: 'working', value: working.length, color: 'var(--flock-accent)' },
          { label: 'agents', value: open.length, color: 'var(--flock-ink-muted)' },
        ].map((t) => (
          <span
            key={t.label}
            className="flex items-center gap-1.5 rounded-full border border-[var(--flock-border)] bg-flock-surface-1 px-2.5 py-1 text-xs text-flock-ink-muted"
          >
            <span
              className="font-semibold tabular-nums"
              style={{ color: t.value > 0 ? t.color : 'var(--flock-ink-muted)' }}
            >
              {t.value}
            </span>
            {t.label}
          </span>
        ))}

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

      {open.length === 0 ? (
        <div className="relative flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-flock-surface-2 text-flock-accent">
            <Layers className="size-7" />
          </div>
          <p className="text-sm text-flock-ink-muted">No agents running yet.</p>
          <button
            type="button"
            onClick={() => openDialog('session')}
            className="rounded-md bg-flock-accent px-3 py-1.5 text-sm font-medium text-white"
          >
            Launch your first agent
          </button>
        </div>
      ) : (
        <div className="relative space-y-6 px-6 pb-8">
          {calm ? (
            <section data-testid="mc-quickstart">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-flock-ink-muted">
                Quick start
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {quickStart.map((q) => {
                  const Icon = q.icon;
                  return (
                    <button
                      key={q.label}
                      type="button"
                      onClick={q.onClick}
                      className={`group flex items-center gap-3 rounded-xl border p-4 text-left transition-colors ${
                        q.primary
                          ? 'border-flock-accent/50 bg-flock-accent/10 hover:border-flock-accent'
                          : 'border-[var(--flock-border)] bg-flock-surface-1 hover:border-flock-accent/50'
                      }`}
                    >
                      <span
                        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                          q.primary ? 'bg-flock-accent text-white' : 'bg-flock-surface-2 text-flock-accent'
                        }`}
                      >
                        <Icon className="size-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-flock-ink-primary">{q.label}</span>
                        <span className="block truncate text-2xs text-flock-ink-muted">{q.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
          {needs.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-status-awaiting">
                Needs you
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {needs.map((s) => renderCard(s))}
              </div>
            </section>
          ) : null}
          {changed.length > 0 ? (
            <section data-testid="mc-changes">
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-flock-ink-muted">
                <GitBranch className="size-3.5" /> Uncommitted changes
              </h2>
              <div className="space-y-1.5">
                {changed.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2.5 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-3 py-2"
                  >
                    <StatusDot status={statusOf(s)} pulse={statusOf(s) === 'awaiting_input'} />
                    <button
                      type="button"
                      onClick={() => openSession(s)}
                      className="shrink-0 truncate text-sm font-medium text-flock-ink-primary hover:text-flock-accent"
                    >
                      {s.agentType}
                    </button>
                    <span className="min-w-0 flex-1 truncate text-2xs text-flock-ink-muted">
                      {nodeName(s.nodeId)} · {projectName(s.projectId)}
                    </span>
                    <GitBadge git={fleetGit.get(s.id)} className="shrink-0" />
                    <button
                      type="button"
                      onClick={() => review_(s)}
                      className="shrink-0 rounded-md bg-flock-accent/15 px-2 py-1 text-2xs font-semibold text-flock-accent hover:bg-flock-accent/25"
                    >
                      Review →
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {teams.length > 0 ? (
            <section data-testid="mc-teams">
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-flock-accent">
                <Network className="size-3.5" /> Teams · agents collaborating
              </h2>
              <div className="space-y-2">
                {teams.map(({ lead, children }) => (
                  <div key={lead.id} className="rounded-xl border border-flock-accent/30 bg-flock-surface-1 p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-flock-accent/15 text-flock-accent">
                        <Network className="size-3" />
                      </span>
                      <button
                        type="button"
                        onClick={() => openSession(lead)}
                        className="truncate font-semibold text-flock-ink-primary hover:text-flock-accent"
                      >
                        {lead.agentType}
                      </button>
                      <span className="text-2xs text-flock-ink-muted">
                        spawned {children.length} agent{children.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 pl-7">
                      {children.map((k) => (
                        <button
                          key={k.id}
                          type="button"
                          onClick={() => openSession(k)}
                          title={latestChats[k.id]?.text ?? ''}
                          className="flex items-center gap-1.5 rounded-full border border-[var(--flock-border)] bg-flock-surface-2 px-2 py-1 text-2xs hover:border-flock-accent"
                        >
                          <StatusDot status={statusOf(k)} pulse={statusOf(k) === 'awaiting_input'} />
                          <span className="text-flock-ink-primary">{k.agentType}</span>
                          <span className="text-flock-ink-muted">{statusLabel(statusOf(k))}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {review.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-status-running">
                Ready to review
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {review.map((s) => renderCard(s, { review: true }))}
              </div>
            </section>
          ) : null}
          {working.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-flock-ink-muted">
                Working
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {working.map((s) => renderCard(s))}
              </div>
            </section>
          ) : null}
          {quiet.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-flock-ink-muted/70">
                Idle
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {quiet.map((s) => renderCard(s))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default MissionControl;
