/**
 * SessionPane — the center region for a selected session: a slim Codex-style
 * header (breadcrumb · status · actions) above the Terminal | Browser | Diff tab
 * group. Shows a calm empty state when nothing is selected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, Command, GitBranch, LayoutGrid, Maximize2, Minimize2, PanelBottom, PanelRight, SquareTerminal, XCircle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { statusLabel, type AgentType, type Session } from '@flock/shared';
import { RightPanel, RightRail } from './RightPanel';
import { RespondBar } from './RespondBar';
import { GridView } from './GridView';
import { handoffSession } from '../../data/treeApi';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SimpleTooltip,
  type BadgeProps,
} from '../../components/ui';

/** Common authed handoff targets (the source's own type is filtered out at render). */
const HANDOFF_TARGETS: ReadonlyArray<{ type: AgentType; label: string }> = [
  { type: 'claude-code', label: 'Claude' },
  { type: 'codex', label: 'Codex' },
  { type: 'gemini', label: 'Gemini' },
  { type: 'grok', label: 'Grok' },
  { type: 'opencode', label: 'OpenCode' },
];
import { useShell } from '../../app/KeyboardProvider';
import { usePaddock } from '../../store/paddock';
import { useNodes, useProjects, useSessions, useSessionEvents, useGitStatus } from '../../data/queries';
import { useLiveStatuses } from './liveData';
import { StatusDot } from '../../components/StatusDot';

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  starting: 'neutral',
  running: 'accent',
  awaiting_input: 'warning',
  idle: 'success',
  done: 'neutral',
  error: 'danger',
  disconnected: 'outline',
};

/** Current branch + ahead/behind for the focused session; click → diff panel.
 *  Renders null until git status loads / when the workdir isn't a repo. */
function BranchChip({ sessionId }: { sessionId: string }): JSX.Element | null {
  const { data: git } = useGitStatus(sessionId);
  const openRight = usePaddock((s) => s.openRight);
  if (!git?.branch) return null;
  return (
    <button
      type="button"
      onClick={() => openRight('diff')}
      title="Open Source Control"
      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
    >
      <GitBranch className="size-3" />
      <span className="max-w-[10rem] truncate font-medium">{git.branch}</span>
      {git.ahead > 0 ? <span className="tabular-nums">↑{git.ahead}</span> : null}
      {git.behind > 0 ? <span className="tabular-nums">↓{git.behind}</span> : null}
      {git.files.length > 0 ? (
        <span className="tabular-nums text-flock-accent">·{git.files.length}</span>
      ) : null}
    </button>
  );
}

function Header({ session }: { session: Session }): JSX.Element {
  const { data: projects = [] } = useProjects();
  const { data: nodes = [] } = useNodes();
  const project = projects.find((p) => p.id === session.projectId);
  const node = nodes.find((n) => n.id === session.nodeId);
  // Terminate is destructive → go through the confirm dialog (same as the grid),
  // never a direct mutate.
  const openDialog = usePaddock((s) => s.openDialog);
  const openOverview = usePaddock((s) => s.openOverview);
  const zenMode = usePaddock((s) => s.zenMode);
  const toggleZen = usePaddock((s) => s.toggleZen);
  const qc = useQueryClient();
  const handoff = useMutation({
    mutationFn: (t: AgentType) => handoffSession(session.id, t),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      usePaddock.getState().focusSession(r.session.id);
    },
  });
  const { toggleDrawer, openPalette } = useShell();
  // Attention spine: how many OTHER agents need you right now (persistent, so you
  // never miss one while heads-down in this session). Click → the Paddock fleet.
  const { data: allSessions = [] } = useSessions();
  const liveStatuses = useLiveStatuses();
  const needsYou = allSessions.filter(
    (s) => s.closedAt === null && s.id !== session.id && (liveStatuses.get(s.id) ?? s.status) === 'awaiting_input',
  ).length;
  // Live status overlay — `session.status` is the REST write-behind mirror and
  // lags the WS, which made this header contradict the sidebar dot for the SAME
  // session (header "Running" vs sidebar "Awaiting input").
  const liveStatus = liveStatuses.get(session.id) ?? session.status;

  // Status-driven accent (bold design language): the header underline reflects
  // the agent's live state, tying the workspace to the same status colors as the
  // Paddock home.
  const accentVar = `var(--flock-status-${liveStatus === 'awaiting_input' ? 'awaiting' : liveStatus})`;
  return (
    <header
      className="flex h-topbar shrink-0 items-center gap-3 border-b-2 bg-flock-surface-1 px-4"
      style={{ borderBottomColor: accentVar }}
    >
      {/* Focus mode = zoomed into one session; this is the way back to the grid. */}
      <Button
        size="sm"
        variant="secondary"
        className="shrink-0 gap-1.5"
        onClick={() => usePaddock.getState().setViewMode('grid')}
        title="Back to the side-by-side grid"
      >
        <ArrowLeft className="size-3.5" />
        <LayoutGrid className="size-3.5" />
        Grid
      </Button>
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate text-flock-ink-muted">{node?.name ?? 'node'}</span>
        <span className="text-flock-ink-muted/50">/</span>
        <span className="truncate text-flock-ink-muted">{project?.name ?? 'project'}</span>
        <span className="text-flock-ink-muted/50">/</span>
        <span className="truncate font-medium text-flock-ink-primary">{session.agentType}</span>
        <code className="ml-1 rounded bg-flock-surface-2 px-1 py-0.5 text-2xs text-flock-ink-muted">
          {session.id.slice(0, 8)}
        </code>
      </div>

      <Badge variant={STATUS_VARIANT[liveStatus] ?? 'neutral'} className="ml-1">
        <StatusDot status={liveStatus} />
        {statusLabel(liveStatus)}
      </Badge>

      <BranchChip sessionId={session.id} />

      {/* Attention spine: other agents waiting on you, always visible → Paddock. */}
      {needsYou > 0 ? (
        <button
          type="button"
          onClick={() => openOverview()}
          data-testid="needs-you-strip"
          title="Other agents are waiting on you — open Paddock"
          className="ml-2 flex shrink-0 items-center gap-1.5 rounded-full bg-status-awaiting/15 px-2.5 py-1 text-2xs font-semibold text-status-awaiting animate-flock-pulse"
        >
          <span className="size-1.5 rounded-full bg-status-awaiting" />
          {needsYou} need{needsYou === 1 ? 's' : ''} you
        </button>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <SimpleTooltip label="Command palette  ⌘K">
          <Button size="icon-sm" variant="ghost" aria-label="Command palette" onClick={openPalette}>
            <Command className="size-4" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Shell drawer  ⌘J">
          <Button size="icon-sm" variant="ghost" aria-label="Toggle shell drawer" onClick={toggleDrawer}>
            <PanelBottom className="size-4" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Toggle side panel">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle side panel"
            onClick={usePaddock.getState().toggleRight}
          >
            <PanelRight className="size-4" />
          </Button>
        </SimpleTooltip>
        <DropdownMenu>
          <SimpleTooltip label="Hand off task to another agent">
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Hand off" disabled={handoff.isPending}>
                <ArrowRightLeft className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </SimpleTooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Hand off to…</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {HANDOFF_TARGETS.filter((t) => t.type !== session.agentType).map((t) => (
              <DropdownMenuItem key={t.type} onSelect={() => handoff.mutate(t.type)}>
                {t.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <SimpleTooltip label={zenMode ? 'Exit focus mode' : 'Focus mode — fill the screen with this agent'}>
          <Button
            size="icon-sm"
            variant={zenMode ? 'secondary' : 'ghost'}
            aria-label={zenMode ? 'Exit focus mode' : 'Enter focus mode'}
            onClick={toggleZen}
          >
            {zenMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Terminate session">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Terminate session"
            onClick={() => openDialog('terminate-session', { sessionId: session.id })}
          >
            <XCircle className="size-4 text-status-error" />
          </Button>
        </SimpleTooltip>
      </div>
    </header>
  );
}

function EmptyState(): JSX.Element {
  const openDialog = usePaddock((s) => s.openDialog);
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden text-center">
      <div className="relative flex size-14 items-center justify-center rounded-xl bg-flock-surface-2 text-flock-accent">
        <SquareTerminal className="size-7" />
      </div>
      <div className="relative max-w-sm">
        <h2 className="font-display text-xl font-bold tracking-tight text-flock-ink-primary">No session selected</h2>
        <p className="mt-1 text-sm text-flock-ink-muted">
          Pick a session from the sidebar, or start a new one to bring up its live terminal.
        </p>
      </div>
      <Button className="relative" onClick={() => openDialog('session')}>
        <SquareTerminal className="size-4" /> Start a session
      </Button>
    </div>
  );
}

const PANEL_MIN = 360;
const PANEL_DEFAULT = 520;
const PANEL_WIDTH_KEY = 'flock.rightPanelWidth';

export function SessionPane(): JSX.Element {
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const { data: sessions = [] } = useSessions();
  const session = selectedId ? (sessions.find((x) => x.id === selectedId) ?? null) : null;

  const rightOpen = usePaddock((s) => s.rightOpen);
  const viewMode = usePaddock((s) => s.viewMode);
  const zenMode = usePaddock((s) => s.zenMode);
  const setZen = usePaddock((s) => s.setZen);
  // Never strand the user in zen with no session (e.g. the focused agent was
  // terminated) — there'd be no header to exit from. Drop back to the normal shell.
  useEffect(() => {
    if (zenMode && !session) setZen(false);
  }, [zenMode, session, setZen]);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : PANEL_DEFAULT;
  });
  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  // Drag the divider to resize the right panel (clamped; never starves the terminal).
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent): void => {
      const rect = container.getBoundingClientRect();
      const next = rect.right - ev.clientX;
      const max = Math.max(PANEL_MIN, rect.width - 360); // keep ≥360px for the terminal
      setPanelWidth(Math.min(Math.max(next, PANEL_MIN), max));
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // GridView is the ONE, always-mounted terminal surface for BOTH grid and focus
  // modes — focus just maximizes one of its cells via CSS (the others stay mounted,
  // merely hidden). Rendering it at a SINGLE stable position means switching
  // grid↔focus, switching the focused session, or adding a session never unmounts a
  // terminal → no PTY reconnect, instant switch. The focus chrome (header + side
  // panel) layers AROUND that surface; in grid mode GridView shows its own tab
  // strip and `focusSession` is null so no chrome is added.
  // Adaptive surfacing: when the focused agent flips to awaiting_input, bring Talk
  // (the conversation) forward so the question + Approve/Deny are right there — the
  // layout follows the agent. Only fires on the transition; never fights a manual
  // switch otherwise.
  const liveStatuses = useLiveStatuses();
  const focusSession = viewMode === 'focus' ? session : null;
  const focusStatus = focusSession ? (liveStatuses.get(focusSession.id) ?? focusSession.status) : null;
  useEffect(() => {
    if (focusStatus !== 'awaiting_input') return;
    const st = usePaddock.getState();
    if (!st.rightOpen || st.rightTab !== 'chat') st.openRight('chat');
  }, [focusStatus, focusSession?.id]);

  // Adaptive surfacing #2: follow the agent's latest TOOL — when it edits files,
  // bring Code (diff) forward; when it browses the web, bring Web forward. Keyed on
  // the latest tool event id so it fires once per new tool, not on every render.
  const { data: focusEvents = [] } = useSessionEvents(focusSession?.id ?? null);
  const lastTool = useMemo(() => {
    for (let i = focusEvents.length - 1; i >= 0; i--) {
      const raw = focusEvents[i]!.agentEventRaw as { chat?: { role?: string; text?: string } } | null;
      if (raw?.chat?.role === 'tool') return { id: focusEvents[i]!.id, text: (raw.chat.text ?? '').toLowerCase() };
    }
    return null;
  }, [focusEvents]);
  useEffect(() => {
    if (!lastTool) return;
    const st = usePaddock.getState();
    if (/edit|write|patch|apply|create|str_replace|multiedit/.test(lastTool.text)) {
      if (st.rightTab !== 'diff') st.openRight('diff');
    } else if (/web|browser|fetch|url|navigate|screenshot/.test(lastTool.text)) {
      if (st.rightTab !== 'browser') st.openRight('browser');
    }
  }, [lastTool?.id]);

  const open = sessions.filter((s) => s.closedAt === null);
  if (open.length === 0) return <EmptyState />;
  // The right panel (Activity/Diff/Browser) targets ONE session. In focus mode
  // that's the focused session; in GRID mode we still show it for the selected
  // session (or the first open one) so the side panel is available in multiview.
  const panelSession = focusSession ?? session ?? open[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {focusSession ? (
        <>
          <Header session={focusSession} />
          <RespondBar session={focusSession} />
        </>
      ) : null}
      <div ref={splitRef} className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <GridView />
        </div>
        {panelSession ? (
          rightOpen ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel"
                onMouseDown={onDragStart}
                className="w-1 shrink-0 cursor-col-resize bg-[var(--flock-border)] hover:bg-flock-accent/50"
              />
              <div className="min-w-0 shrink-0" style={{ width: panelWidth }}>
                <RightPanel session={panelSession} />
              </div>
            </>
          ) : (
            // Collapsed → a thin icon rail; clicking an icon expands to that tab.
            <RightRail />
          )
        ) : null}
      </div>
    </div>
  );
}
