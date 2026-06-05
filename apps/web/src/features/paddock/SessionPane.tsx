/**
 * SessionPane — the center region for a selected session: a slim Codex-style
 * header (breadcrumb · status · actions) above the Terminal | Browser | Diff tab
 * group. Shows a calm empty state when nothing is selected.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Command, LayoutGrid, PanelBottom, PanelRight, SquareTerminal, XCircle } from 'lucide-react';
import { statusLabel, type Session } from '@flock/shared';
import { RightPanel, RightRail } from './RightPanel';
import { GridView } from './GridView';
import { Badge, Button, SimpleTooltip, type BadgeProps } from '../../components/ui';
import { useShell } from '../../app/KeyboardProvider';
import { usePaddock } from '../../store/paddock';
import { useNodes, useProjects, useSessions } from '../../data/queries';
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

function Header({ session }: { session: Session }): JSX.Element {
  const { data: projects = [] } = useProjects();
  const { data: nodes = [] } = useNodes();
  const project = projects.find((p) => p.id === session.projectId);
  const node = nodes.find((n) => n.id === session.nodeId);
  // Terminate is destructive → go through the confirm dialog (same as the grid),
  // never a direct mutate.
  const openDialog = usePaddock((s) => s.openDialog);
  const { toggleDrawer, openPalette } = useShell();
  // Live status overlay — `session.status` is the REST write-behind mirror and
  // lags the WS, which made this header contradict the sidebar dot for the SAME
  // session (header "Running" vs sidebar "Awaiting input").
  const liveStatus = useLiveStatuses().get(session.id) ?? session.status;

  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-[var(--flock-border)] bg-flock-surface-1 px-4">
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.4]"
        style={{
          background:
            'radial-gradient(60rem 30rem at 50% -10%, color-mix(in srgb, var(--flock-accent) 10%, transparent), transparent 70%)',
        }}
      />
      <div className="relative flex size-14 items-center justify-center rounded-xl bg-flock-surface-2 text-flock-accent">
        <SquareTerminal className="size-7" />
      </div>
      <div className="relative max-w-sm">
        <h2 className="text-lg font-semibold tracking-tight text-flock-ink-primary">No session selected</h2>
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
  const open = sessions.filter((s) => s.closedAt === null);
  if (open.length === 0) return <EmptyState />;
  const focusSession = viewMode === 'focus' ? session : null;
  // The right panel (Activity/Diff/Browser) targets ONE session. In focus mode
  // that's the focused session; in GRID mode we still show it for the selected
  // session (or the first open one) so the side panel is available in multiview.
  const panelSession = focusSession ?? session ?? open[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {focusSession ? <Header session={focusSession} /> : null}
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
