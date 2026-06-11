/**
 * GridView — the per-PROJECT terminal grid (the hive supervision view), KANBAN
 * style. Every terminal is a real session; the current project's sessions tile
 * side by side. Panes GROW to fill when there are few, but never shrink below a
 * readable ~80-column floor — once they'd hit it the row scrolls HORIZONTALLY
 * (open as many as you like; none ever gets too small). A VS Code-style tab strip
 * across the top is the minimap: click a tab to SCROLL that pane into view (it does
 * not switch away from the others), double-click to maximize, × to terminate, and
 * the "⌄" menu jumps to any pane when there are more than fit. Newly opened panes
 * auto-scroll into view; tabs whose pane is on screen are highlighted.
 *
 * NOTE: deliberately NOT react-resizable-panels — that always fills 100% width and
 * can't scroll. The kanban floor + scroll replaces hand-resizing.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, ChevronDown, Columns3, LayoutGrid, Plus, Rows3, SquareArrowOutUpRight, X } from 'lucide-react';
import { StatusDot } from '../../components/StatusDot';
import { statusLabel, type Session, type Status } from '@flock/shared';

import { TerminalArea } from '../terminal/TerminalArea';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SimpleTooltip,
} from '../../components/ui';
import { usePaddock, type GridLayout } from '../../store/paddock';
import { useProjects, useSessions } from '../../data/queries';
import { useAgentdHealth, useLiveStatuses } from './liveData';
import { ContextMeter } from './ContextMeter';
import { moveBefore, orderSessions, SESSION_DND } from './sessionOrder';
import { formatCostUsd, formatTokens } from '../../lib/utils';

/**
 * The grid has two user-selectable layouts for 2+ sessions (store `gridLayout`,
 * persisted; toggle in the tab bar):
 *  - 'columns' (default): full-height columns side-by-side — up to FILL_COLS (2)
 *    share the width equally, beyond that each locks to the FILL_COLS-up width and
 *    the row scrolls HORIZONTALLY (so no terminal ever gets shorter; the 3rd is a
 *    full-height column to the right). Best for actually watching agents work.
 *  - 'grid': fixed 2-up, rows at least GRID_MIN_ROW_PX tall, scrolling VERTICALLY
 *    — denser when you have many sessions.
 * Either way the grid is never more than 2 wide. Focus mode is unaffected (it
 * maximizes one cell via CSS).
 */
const FILL_COLS = 2;
const OVERFLOW_PANE_WIDTH = `calc((100% - ${(FILL_COLS - 1) * 0.5}rem) / ${FILL_COLS})`;
const GRID_MIN_ROW_PX = 280;

interface CellUsage {
  live: boolean;
  tokens?: number;
  tool?: string;
  model?: string;
  contextPct?: number;
  contextTokens?: number;
  contextLimit?: number;
  costUsd?: number;
}



function sessionLabel(s: Session): string {
  return `${s.agentType} · ${s.id.slice(0, 6)}`;
}

/**
 * One session's terminal in the grid. Mounts a frame late so xterm fits its pane.
 * Memoized (see {@link GridCell}) so a live-status tick on ONE session doesn't
 * re-render every other cell (and pointlessly re-render their live terminals).
 */
function GridCellInner({
  session,
  status,
  usage,
  focused = false,
}: {
  session: Session;
  status: Status;
  usage?: CellUsage;
  /**
   * This cell is the maximized one in FOCUS mode: drop the grid chrome (its mini
   * header/footer — the big SessionPane header covers that) and claim the shared
   * terminal-input writer so the file tree / drag-drop type into it.
   */
  focused?: boolean;
}): JSX.Element {
  const setViewMode = usePaddock((s) => s.setViewMode);
  const selectSession = usePaddock((s) => s.selectSession);
  const openDialog = usePaddock((s) => s.openDialog);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const focus = (): void => {
    selectSession(session.id);
    setViewMode('focus');
  };
  // Clicking ANYWHERE in a cell (incl. the terminal body) SELECTS that session so
  // the right panel follows the pane you're actually working in — WITHOUT
  // maximizing (maximize stays on double-click / the maximize button). Capture
  // phase + getState guard: runs even if xterm stops mousedown propagation, and
  // skips a redundant store write (and cell re-render) when already selected.
  const selectThis = (): void => {
    if (usePaddock.getState().selectedSessionId !== session.id) selectSession(session.id);
  };
  const attention = status === 'awaiting_input';
  const footerParts: string[] = [];
  if (usage?.model) footerParts.push(usage.model);
  if (usage?.tool) footerParts.push(usage.tool);
  if (usage?.tokens) footerParts.push(`${formatTokens(usage.tokens)} tok`);
  if (usage?.costUsd != null) footerParts.push(formatCostUsd(usage.costUsd));

  return (
    <div
      className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-flock-bg shadow-[0_8px_26px_-16px_rgba(0,0,0,0.7)] ${
        attention
          ? 'border-status-awaiting ring-1 ring-status-awaiting'
          : 'border-[var(--flock-border)] ring-1 ring-white/[0.03]'
      }`}
      data-testid={`grid-cell-${session.id}`}
      data-status={status}
      onMouseDownCapture={selectThis}
    >
      {focused ? null : (
      <div
        className="group/cell flex h-7 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] bg-flock-surface-1 px-2 text-xs"
        onDoubleClick={focus}
        title="Double-click to maximize"
      >
        <span className="flock-status-dot shrink-0" data-status={status} data-testid={`grid-dot-${session.id}`} />
        <button
          type="button"
          onClick={focus}
          className="min-w-0 flex-1 truncate text-left font-medium text-flock-ink-primary hover:text-flock-accent"
          title="Focus this session"
        >
          {sessionLabel(session)}
        </button>
        {usage?.contextPct != null ? (
          <ContextMeter
            pct={usage.contextPct}
            tokens={usage.contextTokens}
            limit={usage.contextLimit}
            className="shrink-0"
          />
        ) : null}
        <span className="shrink-0 text-2xs text-flock-ink-muted">{statusLabel(status)}</span>
        <SimpleTooltip label="Maximize session">
          <button
            type="button"
            onClick={focus}
            aria-label="Focus session"
            className="shrink-0 rounded p-0.5 text-flock-ink-muted opacity-0 transition-opacity hover:bg-flock-surface-2 hover:text-flock-ink-primary focus-visible:opacity-100 group-hover/cell:opacity-100"
          >
            <SquareArrowOutUpRight className="size-3" />
          </button>
        </SimpleTooltip>
        <SimpleTooltip label="Terminate session">
          <button
            type="button"
            onClick={() => openDialog('terminate-session', { sessionId: session.id })}
            aria-label="Terminate session"
            className="shrink-0 rounded p-0.5 text-flock-ink-muted opacity-0 transition-opacity hover:bg-flock-surface-2 hover:text-status-error focus-visible:opacity-100 group-hover/cell:opacity-100"
          >
            <X className="size-3" />
          </button>
        </SimpleTooltip>
      </div>
      )}
      <div className="relative min-h-0 flex-1">
        {ready ? (
          <TerminalArea session={session} register={focused} />
        ) : (
          <div className="h-full w-full bg-flock-bg" />
        )}
      </div>
      {!focused && footerParts.length > 0 ? (
        <div
          className="flex h-5 shrink-0 items-center gap-1.5 border-t border-[var(--flock-border)] bg-flock-surface-1 px-2 text-2xs text-flock-ink-muted/70"
          data-testid={`grid-usage-${session.id}`}
        >
          {usage?.live ? <span className="size-1.5 shrink-0 rounded-full bg-status-running" /> : null}
          <span className="truncate">{footerParts.join(' · ')}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memoized cell: re-render only when THIS session's identity or live signals
 * actually change. Compared on primitives (status + the usage fields) rather than
 * object identity, since `usage` is a fresh object on every agentd-health poll.
 */
const GridCell = memo(
  GridCellInner,
  (a, b) =>
    // Compare the session by the fields this cell actually renders (id + label),
    // NOT object identity: useSessions() returns a FRESH array of fresh objects on
    // every 5s poll, so `a.session === b.session` was ALWAYS false and the memo
    // never held — every cell (and its live terminal subtree) re-rendered on every
    // poll and every status tick. id+agentType is all the cell reads.
    a.session.id === b.session.id &&
    a.session.agentType === b.session.agentType &&
    a.focused === b.focused &&
    a.status === b.status &&
    a.usage?.live === b.usage?.live &&
    a.usage?.tokens === b.usage?.tokens &&
    a.usage?.tool === b.usage?.tool &&
    a.usage?.model === b.usage?.model &&
    a.usage?.contextPct === b.usage?.contextPct &&
    a.usage?.costUsd === b.usage?.costUsd,
);

/** Saved-layouts menu: recall a named grid arrangement (layout + session order) in
 *  one click, or save the current one ("Backend trio", "Review pair"). */
function LayoutPresetsMenu({ projectId, order }: { projectId: string | null; order: string[] }): JSX.Element {
  const presets = usePaddock((s) => s.layoutPresets);
  const saveLayoutPreset = usePaddock((s) => s.saveLayoutPreset);
  const applyLayoutPreset = usePaddock((s) => s.applyLayoutPreset);
  const deleteLayoutPreset = usePaddock((s) => s.deleteLayoutPreset);
  const mine = projectId ? presets.filter((p) => p.projectId === projectId) : [];
  return (
    <DropdownMenu>
      <SimpleTooltip label="Saved layouts">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Saved layouts">
            <Bookmark className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>Layouts</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {mine.length === 0 ? (
          <DropdownMenuItem disabled>No saved layouts</DropdownMenuItem>
        ) : (
          mine.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={(e) => e.preventDefault()}
              className="group/lp gap-2 p-0"
            >
              <button
                type="button"
                onClick={() => applyLayoutPreset(p.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                <Bookmark className="size-3.5 shrink-0 text-flock-ink-muted" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-2xs text-flock-ink-muted">
                  {p.gridLayout === 'grid' ? '2-wide' : 'columns'}
                </span>
              </button>
              <button
                type="button"
                aria-label="Delete layout"
                onClick={() => deleteLayoutPreset(p.id)}
                className="shrink-0 px-2 py-1.5 opacity-0 transition-opacity hover:text-status-error group-hover/lp:opacity-100"
              >
                <X className="size-3" />
              </button>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!projectId || order.length === 0}
          onSelect={() => {
            const name = window.prompt('Name this layout (e.g. "Backend trio")')?.trim();
            if (name && projectId) saveLayoutPreset(name, projectId, order);
          }}
        >
          <Plus className="size-3.5" /> Save current layout…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The VS Code-style tab strip: a minimap over the scrollable pane row. */
function GridTabBar({
  cells,
  statuses,
  visibleIds,
  projectName,
  canAdd,
  layout,
  onToggleLayout,
  onJump,
  onMaximize,
  onClose,
  onNew,
  onReorder,
}: {
  cells: Session[];
  statuses: ReadonlyMap<string, Status>;
  visibleIds: ReadonlySet<string>;
  projectName: string;
  layout: GridLayout;
  onToggleLayout: () => void;
  canAdd: boolean;
  onJump: (id: string) => void;
  onMaximize: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (fromId: string, toId: string) => void;
}): JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] bg-flock-surface-1 pl-3 pr-1.5"
      data-testid="grid-tabbar"
    >
      <LayoutGrid className="size-4 shrink-0 text-flock-accent" />
      <span className="font-display shrink-0 truncate text-sm font-semibold text-flock-ink-primary">{projectName}</span>
      <span className="shrink-0 rounded-full bg-flock-surface-2 px-1.5 text-2xs tabular-nums text-flock-ink-muted">{cells.length}</span>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="grid-tabs">
        {cells.map((s) => {
          const status = statuses.get(s.id) ?? s.status;
          const onScreen = visibleIds.has(s.id);
          return (
            <div
              key={s.id}
              data-testid={`grid-tab-${s.id}`}
              data-active={onScreen}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SESSION_DND, s.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(SESSION_DND)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                const from = e.dataTransfer.getData(SESSION_DND);
                if (from) {
                  e.preventDefault();
                  onReorder(from, s.id);
                }
              }}
              className={`group/tab flex h-7 shrink-0 cursor-grab items-center gap-1.5 rounded-md px-2 text-xs active:cursor-grabbing ${
                onScreen
                  ? 'bg-flock-accent/15 text-flock-ink-primary ring-1 ring-flock-accent/25'
                  : 'text-flock-ink-muted hover:bg-flock-surface-2/60 hover:text-flock-ink-primary'
              }`}
            >
              <button
                type="button"
                onClick={() => onJump(s.id)}
                onDoubleClick={() => onMaximize(s.id)}
                className="flex min-w-0 items-center gap-1.5"
                title="Click to scroll into view · double-click to maximize · drag to reorder"
              >
                <StatusDot status={status} className="shrink-0" />
                <span className="max-w-[11rem] truncate">{sessionLabel(s)}</span>
              </button>
              <button
                type="button"
                aria-label="Terminate session"
                onClick={() => onClose(s.id)}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover/tab:opacity-100 hover:text-status-error"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1 pl-1">
        {cells.length > 1 && (
          <>
          <SimpleTooltip
            label={layout === 'columns' ? 'Switch to 2-wide grid' : 'Switch to full-height columns'}
          >
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle grid layout"
              onClick={onToggleLayout}
            >
              {layout === 'columns' ? <Rows3 className="size-4" /> : <Columns3 className="size-4" />}
            </Button>
          </SimpleTooltip>
          <DropdownMenu>
            <SimpleTooltip label="Jump to a terminal">
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="All terminals">
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </SimpleTooltip>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>Terminals</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {cells.map((s) => (
                <DropdownMenuItem key={s.id} onSelect={() => onJump(s.id)} className="gap-2">
                  <StatusDot status={statuses.get(s.id) ?? s.status} className="shrink-0" />
                  <span className="truncate">{sessionLabel(s)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          </>
        )}
        <LayoutPresetsMenu projectId={cells[0]?.projectId ?? null} order={cells.map((c) => c.id)} />
        <SimpleTooltip label="New session in this project">
          <Button size="icon-sm" variant="ghost" aria-label="New session" disabled={!canAdd} onClick={onNew}>
            <Plus className="size-4" />
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}

export function GridView(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: projects = [] } = useProjects();
  const statuses = useLiveStatuses();
  const agentdHealth = useAgentdHealth();
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const selectSession = usePaddock((s) => s.selectSession);
  const setViewMode = usePaddock((s) => s.setViewMode);
  const viewMode = usePaddock((s) => s.viewMode);
  const gridLayout = usePaddock((s) => s.gridLayout);
  const toggleGridLayout = usePaddock((s) => s.toggleGridLayout);
  const openDialog = usePaddock((s) => s.openDialog);

  const chosenProjectId = usePaddock((s) => s.selectedProjectId);
  const open = useMemo(() => sessions.filter((s) => s.closedAt === null), [sessions]);
  // Project scope, in priority: an EXPLICITLY chosen project (sidebar / `/p/:id`),
  // else the selected session's project (the current workspace). STICKY: when a
  // brand-new session is selected, it isn't in the query cache for a beat (the
  // create does a background invalidate), so `find` returns undefined. Without the
  // sticky fallback the grid would momentarily lose its project → blank ALL panes
  // → every terminal unmounts + reconnects. Remembering the last valid project
  // keeps the existing panes mounted across that gap (the new one just appends).
  const sessionProjectId = open.find((s) => s.id === selectedId)?.projectId ?? null;
  const resolvedProjectId = chosenProjectId ?? sessionProjectId;
  const lastProjectId = useRef<string | null>(null);
  if (resolvedProjectId) lastProjectId.current = resolvedProjectId;
  const projectId = resolvedProjectId ?? lastProjectId.current;
  const project = projects.find((p) => p.id === projectId);
  const sessionOrder = usePaddock((s) => s.sessionOrder);
  const setSessionOrder = usePaddock((s) => s.setSessionOrder);
  // The user's manual drag order (shared with the sidebar); newly created sessions
  // not yet in that order fall to the end (oldest→newest), so a new terminal still
  // appends to the right until the user moves it.
  const cells = useMemo(
    () =>
      orderSessions(
        projectId ? open.filter((s) => s.projectId === projectId) : [],
        projectId ? sessionOrder[projectId] : undefined,
      ),
    [open, projectId, sessionOrder],
  );
  const ids = cells.map((c) => c.id).join(',');

  // Drag-reorder (tabs): move `fromId` to `toId`'s slot, persist the project order.
  const reorder = (fromId: string, toId: string): void => {
    if (!projectId) return;
    setSessionOrder(projectId, moveBefore(cells.map((c) => c.id), fromId, toId));
  };

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cellEls = useRef<Map<string, HTMLElement>>(new Map());
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());

  // In the 2-wide 'grid' layout, a single pane spans full width; 2+ tile two-up.
  const singleCol = cells.length <= 1;
  // 'columns' layout: full-height side-by-side; lock to the FILL_COLS-up width +
  // horizontal scroll once there are more than fit (so none gets shorter).
  const overflow = cells.length > FILL_COLS;

  const scrollToPane = (id: string): void => {
    cellEls.current.get(id)?.scrollIntoView?.({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  };

  // Highlight tabs whose pane is currently on screen (the minimap ↔ scroll sync).
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !scrollRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisibleIds((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.pane;
            if (!id) continue;
            if (e.isIntersecting && e.intersectionRatio >= 0.6) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      { root: scrollRef.current, threshold: [0, 0.6, 1] },
    );
    for (const el of cellEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [ids]);

  // Auto-scroll a newly opened pane into view so it's never created off-screen.
  const prevIds = useRef<string[] | null>(null);
  useEffect(() => {
    const current = cells.map((c) => c.id);
    const prior = prevIds.current;
    prevIds.current = current;
    if (prior === null) return; // first render: don't yank the scroll
    const added = current.filter((id) => !prior.includes(id));
    if (added.length > 0) {
      const target = added[added.length - 1]!;
      requestAnimationFrame(() => scrollToPane(target));
    }
    // Intentionally only re-run when the set of pane ids changes (auto-scroll to
    // a newly added pane); other referenced values are stable refs/setters.
  }, [ids]);

  const maximize = (id: string): void => {
    selectSession(id);
    setViewMode('focus');
  };
  const jump = (id: string): void => {
    selectSession(id);
    scrollToPane(id);
  };

  // FOCUS mode = one session maximized. It is a LAYOUT over the SAME mounted cells,
  // not a different tree: every cell stays mounted (the non-selected ones just
  // `hidden`), so maximizing / restoring / switching the focused session is a pure
  // CSS change — the terminals (and their PTY WebSockets) are never torn down and
  // rebuilt. Only valid when the selection is one of these cells; during the
  // create-gap (a new id selected before it's in the list) we fall back to the grid
  // tiling so nothing blanks. SessionPane renders the focus header/side panel.
  const focused = viewMode === 'focus' && cells.some((c) => c.id === selectedId);
  // Full-height side-by-side columns (vs the 2-up vertical-scroll grid), only when
  // not maximized.
  const columns = !focused && gridLayout === 'columns';

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="grid-view">
      {focused ? null : (
        <GridTabBar
          cells={cells}
          statuses={statuses}
          visibleIds={visibleIds}
          projectName={project ? project.name : 'Agents'}
          canAdd={projectId != null}
          layout={gridLayout}
          onToggleLayout={toggleGridLayout}
          onJump={jump}
          onMaximize={maximize}
          onClose={(id) => openDialog('terminate-session', { sessionId: id })}
          onNew={() => projectId && openDialog('session', { projectId })}
          onReorder={reorder}
        />
      )}

      {cells.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-flock-ink-muted">
          {projectId
            ? 'No terminals in this project yet. Start a session to see it here.'
            : 'Select a session to watch its project’s terminals.'}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={
            focused
              ? 'relative min-h-0 flex-1 p-2'
              : columns
                ? 'flex min-h-0 flex-1 flex-nowrap gap-2 overflow-x-auto p-2'
                : 'grid min-h-0 flex-1 gap-2 overflow-y-auto p-2'
          }
          style={
            focused || columns
              ? undefined
              : {
                  gridTemplateColumns: singleCol ? '1fr' : 'repeat(2, minmax(0, 1fr))',
                  gridAutoRows: `minmax(${GRID_MIN_ROW_PX}px, 1fr)`,
                }
          }
          data-testid="grid-cells"
        >
          {/* COLUMNS: full-height panes; ≤FILL_COLS share width equally, more lock
              to the FILL_COLS-up width + horizontal scroll. GRID: 2-up tiles,
              vertical scroll (a single pane spans full width). FOCUS: the selected
              pane fills, the rest are `hidden` but STAY MOUNTED (no reconnect on
              maximize/switch). Keyed by session id, so add/remove only
              mounts/unmounts THAT pane. */}
          {cells.map((s) => {
            const isFocusedCell = focused && s.id === selectedId;
            return (
              <div
                key={s.id}
                data-pane={s.id}
                ref={(el) => {
                  if (el) cellEls.current.set(s.id, el);
                  else cellEls.current.delete(s.id);
                }}
                className={
                  focused
                    ? isFocusedCell
                      ? 'absolute inset-2'
                      : 'hidden'
                    : columns
                      ? 'h-full'
                      : 'min-h-0 min-w-0'
                }
                style={
                  columns
                    ? overflow
                      ? { flex: `0 0 ${OVERFLOW_PANE_WIDTH}`, width: OVERFLOW_PANE_WIDTH }
                      : { flex: '1 1 0', minWidth: 0 }
                    : undefined
                }
              >
                <GridCell
                  session={s}
                  status={statuses.get(s.id) ?? s.status}
                  usage={agentdHealth?.sessions[s.id]}
                  focused={isFocusedCell}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default GridView;
