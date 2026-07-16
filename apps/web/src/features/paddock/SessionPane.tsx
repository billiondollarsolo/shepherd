/**
 * SessionPane — the center region for a selected session: a slim Codex-style
 * header (breadcrumb · status · actions) above the focused agent terminal
 * group. Shows a calm empty state when nothing is selected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRightLeft,
  Command,
  GitBranch,
  LayoutGrid,
  MessageSquare,
  PanelBottom,
  PanelRight,
  SquareTerminal,
  XCircle,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { statusLabel, type AgentAuthority, type AgentType, type Session } from '@flock/shared';
import { RightPanel } from './RightPanel';
import { RespondBar } from './RespondBar';
import { StageLayout } from '../shell/StageLayout';
import { ChatPanel } from '../chat/ChatPanel';
import { isChatCapable } from '../chat/chatCapable';
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
import { ResizeSeparator } from '../../components/ui/resize-separator';
import { PRODUCT_NAME } from '../../brand';

/** Common authed handoff targets (the source's own type is filtered out at render). */
const HANDOFF_TARGETS: ReadonlyArray<{ type: AgentType; label: string }> = [
  { type: 'claude-code', label: 'Claude' },
  { type: 'codex', label: 'Codex' },
  { type: 'gemini', label: 'Gemini' },
  { type: 'grok', label: 'Grok' },
  { type: 'opencode', label: 'OpenCode' },
];

const AUTHORITY_LABEL: Record<AgentAuthority, string> = {
  callback_only: 'Independent',
  observe: 'Observe',
  collaborate: 'Collaborate',
  delegate: 'Delegate',
  manage: 'Manage',
};
import { useShell } from '../../app/KeyboardProvider';
import { shortcutLabel } from '../../app/commands';
import { usePaddock } from '../../store/paddock';
import { useSessions, useSessionEvents, useGitStatus } from '../../data/queries';
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

/** Segmented Terminal ⇄ Chat switch for the session stage (chat-capable agents). */
function StageViewToggle(): JSX.Element {
  const stageView = usePaddock((s) => s.stageView);
  const setStageView = usePaddock((s) => s.setStageView);
  const options = [
    { v: 'terminal' as const, label: 'Terminal', Icon: SquareTerminal },
    { v: 'chat' as const, label: 'Chat', Icon: MessageSquare },
  ];
  return (
    <div
      role="tablist"
      aria-label="Session view"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--flock-border)] bg-flock-surface-2 p-0.5"
    >
      {options.map(({ v, label, Icon }) => {
        const active = stageView === v;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setStageView(v)}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-flock-surface-0 text-flock-ink-primary shadow-flock-sm'
                : 'text-flock-ink-muted hover:text-flock-ink-primary'
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Header({ session }: { session: Session }): JSX.Element {
  // Terminate is destructive → go through the confirm dialog (same as the grid),
  // never a direct mutate.
  const openDialog = usePaddock((s) => s.openDialog);
  const openMission = usePaddock((s) => s.openMission);
  const chrome = usePaddock((s) => s.chrome);
  const openTools = usePaddock((s) => s.openTools);
  const closeTools = usePaddock((s) => s.closeTools);
  const selectProject = usePaddock((s) => s.selectProject);
  const qc = useQueryClient();
  const handoff = useMutation({
    mutationFn: (t: AgentType) => handoffSession(session.id, t),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      usePaddock.getState().openAgent(r.session.id);
    },
  });
  const { toggleDrawer, openPalette } = useShell();
  // Attention spine: how many OTHER agents need you right now (persistent, so you
  // never miss one while heads-down in this session). Click → the Paddock fleet.
  const { data: allSessions = [] } = useSessions();
  const liveStatuses = useLiveStatuses();
  const needsYou = allSessions.filter(
    (s) =>
      s.closedAt === null &&
      s.id !== session.id &&
      (liveStatuses.get(s.id) ?? s.status) === 'awaiting_input',
  ).length;
  // Live status overlay — `session.status` is the REST write-behind mirror and
  // lags the WS, which made this header contradict the sidebar dot for the SAME
  // session (header "Running" vs sidebar "Awaiting input").
  const liveStatus = liveStatuses.get(session.id) ?? session.status;
  const authority = session.orchestrationAuthority ?? 'callback_only';

  // Secondary context row: TopBar already carries the project/pen scope, so this
  // row stays lean (agent identity + live status + actions) and rules with the
  // one shell hairline instead of a second competing weight.
  return (
    <header className="flex h-subheader shrink-0 items-center gap-3 border-b border-[var(--flock-border)] bg-flock-surface-1 px-4">
      {/* Leave single-agent zoom → show every open agent in this project. */}
      <Button
        size="sm"
        variant="secondary"
        className="shrink-0 gap-1.5"
        onClick={() => selectProject(session.projectId)}
        title="Show all agents in this project side-by-side"
        data-testid="all-agents-btn"
      >
        <ArrowLeft className="size-3.5" />
        <LayoutGrid className="size-3.5" />
        All agents
      </Button>
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate font-medium text-flock-ink-primary">{session.agentType}</span>
        <code className="rounded bg-flock-surface-2 px-1 py-0.5 text-2xs text-flock-ink-muted">
          {session.id.slice(0, 8)}
        </code>
      </div>

      {isChatCapable(session.agentType) ? <StageViewToggle /> : null}

      <Badge variant={STATUS_VARIANT[liveStatus] ?? 'neutral'} className="ml-1">
        <StatusDot status={liveStatus} />
        {statusLabel(liveStatus)}
      </Badge>

      <Badge
        variant={authority === 'manage' ? 'danger' : 'outline'}
        title={`${PRODUCT_NAME} authority: ${AUTHORITY_LABEL[authority]}`}
      >
        {AUTHORITY_LABEL[authority]}
      </Badge>

      <BranchChip sessionId={session.id} />

      {/* Attention spine: other agents waiting on you, always visible → Paddock. */}
      {needsYou > 0 ? (
        <button
          type="button"
          onClick={() => openMission()}
          data-testid="needs-you-strip"
          title="Other agents are waiting on you — open Paddock"
          className="ml-2 flex shrink-0 items-center gap-1.5 rounded-full bg-status-awaiting/15 px-2.5 py-1 text-2xs font-semibold text-status-awaiting animate-flock-pulse"
        >
          <span className="size-1.5 rounded-full bg-status-awaiting" />
          {needsYou} need{needsYou === 1 ? 's' : ''} you
        </button>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <SimpleTooltip label={`Command palette  ${shortcutLabel('command-palette')}`}>
          <Button size="icon-sm" variant="ghost" aria-label="Command palette" onClick={openPalette}>
            <Command className="size-4" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label={`Shell drawer  ${shortcutLabel('shell-drawer')}`}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle shell drawer"
            onClick={toggleDrawer}
          >
            <PanelBottom className="size-4" />
          </Button>
        </SimpleTooltip>
        <DropdownMenu>
          <SimpleTooltip label="Hand off task to another agent">
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Hand off"
                disabled={handoff.isPending}
              >
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
        {/* Single tools control (terminal-first: no dual panel/maximize toggles). */}
        <SimpleTooltip label={chrome === 'tools' ? 'Hide tools' : 'Open tools'}>
          <Button
            size="icon-sm"
            variant={chrome === 'tools' ? 'secondary' : 'ghost'}
            aria-label={chrome === 'tools' ? 'Hide tools' : 'Open tools'}
            data-testid="stage-tools-toggle"
            onClick={() => (chrome === 'tools' ? closeTools() : openTools())}
          >
            <PanelRight className="size-4" />
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
        <h2 className="font-display text-xl font-bold tracking-tight text-flock-ink-primary">
          No session selected
        </h2>
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
const PANEL_STORED_MAX = 1_200;
const PANEL_WIDTH_KEY = 'flock.rightPanelWidth';

function readStoredPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= PANEL_MIN && saved <= PANEL_STORED_MAX
      ? saved
      : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function SessionPane(): JSX.Element {
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const { data: sessions = [] } = useSessions();
  const session = selectedId ? (sessions.find((x) => x.id === selectedId) ?? null) : null;

  const rightOpen = usePaddock((s) => s.rightOpen);
  const chrome = usePaddock((s) => s.chrome);
  const stageView = usePaddock((s) => s.stageView);
  const assistivePanels = usePaddock((s) => s.assistivePanels);
  const closeTools = usePaddock((s) => s.closeTools);
  // If the selected agent vanishes, leave tools chrome so we don't strand UI.
  useEffect(() => {
    if (!session && chrome === 'tools') closeTools();
  }, [session, chrome, closeTools]);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState<number>(readStoredPanelWidth);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // Device-local presentation state is optional (private mode / denied storage).
    }
  }, [panelWidth]);

  // Drag the divider to resize the right panel (clamped; never starves the
  // terminal). The pointer→width math lives here; ResizeSeparator owns the drag
  // lifecycle, touch parity, keyboard stepping, and reset.
  const onPanelDrag = useCallback((ev: PointerEvent): void => {
    const container = splitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const next = rect.right - ev.clientX;
    const max = Math.max(PANEL_MIN, rect.width - 360); // keep ≥360px for the terminal
    setPanelWidth(Math.min(Math.max(next, PANEL_MIN), max));
  }, []);

  // GridView is the ONE always-mounted terminal surface. Stage header when a
  // session is selected; adaptive panels only when assistivePanels is on (D5).
  const liveStatuses = useLiveStatuses();
  const stageSession = session;
  const focusStatus = stageSession
    ? (liveStatuses.get(stageSession.id) ?? stageSession.status)
    : null;
  useEffect(() => {
    if (!assistivePanels) return;
    if (focusStatus !== 'awaiting_input') return;
    const st = usePaddock.getState();
    if (!st.rightOpen || st.rightTab !== 'chat') st.openRight('chat');
  }, [focusStatus, stageSession?.id, assistivePanels]);

  const { data: focusEvents = [] } = useSessionEvents(
    assistivePanels ? (stageSession?.id ?? null) : null,
  );
  const lastTool = useMemo(() => {
    if (!assistivePanels) return null;
    for (let i = focusEvents.length - 1; i >= 0; i--) {
      const raw = focusEvents[i]!.agentEventRaw as {
        chat?: { role?: string; text?: string };
      } | null;
      if (raw?.chat?.role === 'tool')
        return { id: focusEvents[i]!.id, text: (raw.chat.text ?? '').toLowerCase() };
    }
    return null;
  }, [focusEvents, assistivePanels]);
  useEffect(() => {
    if (!assistivePanels || !lastTool) return;
    const st = usePaddock.getState();
    if (/edit|write|patch|apply|create|str_replace|multiedit/.test(lastTool.text)) {
      if (st.rightTab !== 'diff') st.openRight('diff');
    }
  }, [lastTool, assistivePanels]);

  const open = sessions.filter((s) => s.closedAt === null);
  if (open.length === 0) return <EmptyState />;
  const panelSession = stageSession;
  const toolsOpen = chrome === 'tools' && rightOpen && panelSession != null;
  // Chat is a first-class alternative to the terminal for agents that produce a
  // transcript; the terminal stays the floor (always mounted, kept alive).
  const stageChatCapable = isChatCapable(stageSession?.agentType);
  const chatActive = stageChatCapable && stageView === 'chat';

  return (
    <div className="flex h-full min-h-0 flex-col" data-chrome={chrome}>
      {stageSession ? (
        <>
          <Header session={stageSession} />
          <RespondBar session={stageSession} />
        </>
      ) : null}
      <div ref={splitRef} className="flex min-h-0 flex-1 bg-flock-surface-1">
        {/* Inset the always-on terminal as a subtly elevated card: a surface-0
            stage floating in the surface-1 frame, ruled by the one shell hairline. */}
        <div className="min-w-0 flex-1 p-2">
          <div className="relative h-full overflow-hidden rounded-lg border border-[var(--flock-border)] bg-flock-surface-0">
            {/* The terminal is ALWAYS mounted (keep-alive PTY). Chat overlays it
                via `invisible` (which preserves layout size) so switching views
                never resizes or tears down the terminal. */}
            <div className={`absolute inset-0 ${chatActive ? 'invisible' : ''}`}>
              <StageLayout />
            </div>
            {stageChatCapable && stageSession ? (
              <div
                className={`absolute inset-0 ${chatActive ? '' : 'invisible pointer-events-none'}`}
                aria-hidden={!chatActive}
              >
                <ChatPanel session={stageSession} />
              </div>
            ) : null}
          </div>
        </div>
        {/* Terminal-first: no right icon-rail until tools are explicitly opened. */}
        {toolsOpen && panelSession ? (
          <>
            <ResizeSeparator
              orientation="vertical"
              label="Resize panel"
              value={Math.round(panelWidth)}
              min={PANEL_MIN}
              max={PANEL_STORED_MAX}
              step={24}
              onDrag={onPanelDrag}
              onValueChange={setPanelWidth}
              onReset={() => setPanelWidth(PANEL_DEFAULT)}
            />
            <div className="min-w-0 shrink-0" style={{ width: panelWidth }}>
              <RightPanel session={panelSession} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
