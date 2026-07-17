/**
 * Sidebar — the supervision tree + navigation (Codex left rail).
 *
 * Brand + global "add" menu at the top, a "needs attention" shortcut list, the
 * collapsible node → project → session tree (the FR-UI3 supervision dashboard),
 * and a footer with theme + settings. Status is conveyed by the small flock
 * status dot, never a loud badge (Appendix A.4 calm density).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Cpu,
  FileCode2,
  FolderGit2,
  GitCompareArrows,
  HardDrive,
  LayoutGrid,
  PanelLeftClose,
  Pin,
  Plus,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import { type Node as FlockNode, type Session, type Status } from '@flock/shared';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  ScrollArea,
  SimpleTooltip,
} from '../../components/ui';
import { BuiltBy } from '../../components/BuiltBy';
import { FlockMark } from '../../components/SheepIcon';
import { StatusDot as Dot } from '../../components/StatusDot';
import { usePaddock, orderNodes } from '../../store/paddock';
import { useNodes, useSessions } from '../../data/queries';
import { useLiveStatuses } from './liveData';
import { AgentsSwitcher } from '../shell/AgentsSwitcher';
import { FLOCK_VERSION } from '../../version';
import { NodeRow, SidebarTreeRoot, WorkspaceList } from './SidebarTree';
import { NODE_CONN_BG, reorderNodeIds, sessionLabel } from './sidebarModel';
import { FLEET_PAGE_SIZE, nextFleetLimit } from '../overview/fleetModel';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '../../brand';

const EMPTY_SESSIONS: Session[] = [];

function SidebarLensNav({ collapsed = false }: { collapsed?: boolean }): JSX.Element {
  const lens = usePaddock((state) => state.lens);
  const openMission = usePaddock((state) => state.openMission);
  const setLens = usePaddock((state) => state.setLens);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1" data-testid="sidebar-lens-nav">
        <SimpleTooltip label="Paddock" side="right">
          <Button
            size="icon-sm"
            variant={lens === 'mission' ? 'secondary' : 'ghost'}
            aria-label="Paddock"
            onClick={() => openMission()}
          >
            <LayoutGrid />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Agents" side="right">
          <Button
            size="icon-sm"
            variant={lens === 'agents' ? 'secondary' : 'ghost'}
            aria-label="Agents"
            onClick={() => setLens('agents')}
          >
            <Bot />
          </Button>
        </SimpleTooltip>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-1 rounded-lg bg-flock-surface-2 p-1"
      data-testid="sidebar-lens-nav"
    >
      <button
        type="button"
        data-active={lens === 'mission' ? '1' : '0'}
        onClick={() => openMission()}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium ${
          lens === 'mission'
            ? 'bg-flock-surface-1 text-flock-ink-primary shadow-sm'
            : 'text-flock-ink-muted hover:text-flock-ink-primary'
        }`}
      >
        <LayoutGrid className="size-3.5" /> Paddock
      </button>
      <button
        type="button"
        data-active={lens === 'agents' ? '1' : '0'}
        onClick={() => setLens('agents')}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium ${
          lens === 'agents'
            ? 'bg-flock-surface-1 text-flock-ink-primary shadow-sm'
            : 'text-flock-ink-muted hover:text-flock-ink-primary'
        }`}
      >
        <Bot className="size-3.5" /> Agents
      </button>
    </div>
  );
}

/**
 * Permission-mode badge for a session row — the at-a-glance safety signal of how
 * autonomous an agent is. `default` (asks before edits) is the safe norm and gets
 * NO badge; the riskier modes are flagged, autonomous most loudly.
 */
function NodeRailItem({
  node,
  sessions,
  statuses,
  onFocus,
  onOpenNode,
  open,
  keptOpen,
  onHoverOpen,
  onHoverCloseSoon,
  onToggleKeepOpen,
  onDismiss,
}: {
  node: FlockNode;
  sessions: Session[];
  statuses: ReadonlyMap<string, Status>;
  onFocus: (id: string, projectId?: string | null) => void;
  onOpenNode: (id: string) => void;
  open: boolean;
  keptOpen: boolean;
  onHoverOpen: () => void;
  onHoverCloseSoon: () => void;
  onToggleKeepOpen: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const NodeIcon = node.kind === 'local' ? Cpu : HardDrive;
  return (
    <Popover open={open} onOpenChange={(o) => !o && onDismiss()}>
      <PopoverAnchor asChild>
        <button
          type="button"
          onClick={onToggleKeepOpen}
          onMouseEnter={onHoverOpen}
          onMouseLeave={onHoverCloseSoon}
          aria-label={`${node.name} (${node.connectionStatus})`}
          aria-pressed={keptOpen}
          className="flex size-10 items-center justify-center rounded-md text-flock-ink-muted outline-none hover:bg-flock-surface-2 hover:text-flock-ink-primary focus-visible:bg-flock-surface-2 aria-pressed:bg-flock-surface-2 aria-pressed:text-flock-ink-primary"
        >
          <span className="relative inline-flex">
            <NodeIcon className="size-5" />
            <span
              className={`absolute -bottom-0.5 -right-1 size-1.5 rounded-full ring-2 ring-flock-surface-1 ${NODE_CONN_BG[node.connectionStatus] ?? 'bg-status-disconnected'}`}
            />
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        onMouseEnter={onHoverOpen}
        onMouseLeave={onHoverCloseSoon}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Don't yank focus back to the anchor on close — a hover-opened flyout
        // returning focus leaves the icon `:focus-visible` (stuck "lit up" bg)
        // after the cursor has moved to another tile.
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="w-56 p-1.5"
      >
        <div className="flex items-center gap-2 px-1.5 pb-1.5">
          <NodeIcon className="size-3.5 shrink-0 text-flock-ink-muted" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-flock-ink-primary">
            {node.name}
          </span>
          {/* Keep open ⇄ Close — persistent flyout state, unrelated to sessions. */}
          <button
            type="button"
            onClick={keptOpen ? onDismiss : onToggleKeepOpen}
            aria-label={keptOpen ? 'Close' : 'Keep open'}
            title={keptOpen ? 'Close' : 'Keep open'}
            className={`shrink-0 rounded p-0.5 hover:bg-flock-surface-2 hover:text-flock-ink-primary ${keptOpen ? 'text-flock-ink-primary' : 'text-flock-ink-muted'}`}
          >
            {keptOpen ? <X className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
        </div>
        <div className="mx-1 h-px bg-[var(--flock-border)]" />
        {sessions.length === 0 ? (
          <p className="px-1.5 py-2 text-2xs text-flock-ink-muted">No open sessions.</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto py-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    onFocus(s.id, s.projectId);
                    onDismiss();
                  }}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-sm text-flock-ink-primary hover:bg-flock-surface-2"
                >
                  <Dot status={statuses.get(s.id) ?? s.status} />
                  <span className="min-w-0 flex-1 truncate text-left">{sessionLabel(s)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mx-1 h-px bg-[var(--flock-border)]" />
        <button
          type="button"
          onClick={() => {
            onOpenNode(node.id);
            onDismiss();
          }}
          className="mt-0.5 flex w-full items-center gap-2 rounded px-1.5 py-1 text-2xs text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <Cpu className="size-3.5" /> Node details
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function Sidebar(): JSX.Element {
  const { data: nodes = [], isLoading } = useNodes();
  const { data: sessions = [] } = useSessions();
  const loaded = !isLoading;
  // Sidebar node order is LOCKED to the user's manual order (no auto-reshuffle on
  // refetch); drag-to-reorder updates it. Un-ordered nodes sort stably by name.
  const nodeOrder = usePaddock((s) => s.nodeOrder);
  const setNodeOrder = usePaddock((s) => s.setNodeOrder);
  const orderedNodes = useMemo(() => orderNodes(nodes, nodeOrder), [nodes, nodeOrder]);
  const [nodeLimit, setNodeLimit] = useState(FLEET_PAGE_SIZE);
  const displayedNodes = orderedNodes.slice(0, nodeLimit);
  const reorderNode = (draggedId: string, targetId: string): void => {
    const ids = orderedNodes.map((n) => n.id);
    setNodeOrder(reorderNodeIds(ids, draggedId, targetId));
  };
  const moveNode = (nodeId: string, direction: -1 | 1): void => {
    const index = orderedNodes.findIndex((node) => node.id === nodeId);
    const target = orderedNodes[index + direction];
    if (target) reorderNode(nodeId, target.id);
  };
  const openDialog = usePaddock((s) => s.openDialog);
  const openSettings = usePaddock((s) => s.openSettings);
  const openMission = usePaddock((s) => s.openMission);
  const lens = usePaddock((s) => s.lens);
  // Open agent on stage (agents lens + terminal-first chrome).
  const select = usePaddock((s) => s.openAgent);
  const collapsed = usePaddock((s) => s.sidebarCollapsed);
  const toggleSidebar = usePaddock((s) => s.toggleSidebar);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const preferencesSaveState = usePaddock((s) => s.preferencesSaveState);
  const preferencesError = usePaddock((s) => s.preferencesError);
  const retryPreferences = usePaddock((s) => s.retryPreferences);

  // Live status overlay + agentd health from the SHARED provider (one WS for the
  // whole paddock — sidebar, tabs, grid). The REST list only has create-time status.
  const statuses = useLiveStatuses();
  const liveStatus = (s: Session): Status => statuses.get(s.id) ?? s.status;

  const attention = useMemo(
    () =>
      sessions.filter((s) => {
        const st = statuses.get(s.id) ?? s.status;
        return st === 'awaiting_input' || st === 'error';
      }),
    [sessions, statuses],
  );

  // Open sessions grouped by node, computed ONCE per sessions change — the
  // collapsed rail's per-node flyout would otherwise re-scan all sessions for
  // every node on every render (and the rail re-renders on every status tick).
  const openSessionsByNode = useMemo(() => {
    const byNode = new Map<string, Session[]>();
    for (const s of sessions) {
      if (s.closedAt !== null) continue;
      const arr = byNode.get(s.nodeId);
      if (arr) arr.push(s);
      else byNode.set(s.nodeId, [s]);
    }
    return byNode;
  }, [sessions]);

  // Collapsed-rail node flyout state, owned HERE (one source of truth) so only ONE
  // flyout is ever open. Two pieces:
  //  - hoverNodeId: the transient HOVER peek (auto-closes when you leave);
  //  - heldNodeId: a kept-open flyout that stays open until explicitly closed.
  // While a flyout is held open, hover previews are ignored.
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [heldNodeId, setHeldNodeId] = useState<string | null>(null);
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flyoutTimer.current), []);
  const hoverOpen = (id: string): void => {
    clearTimeout(flyoutTimer.current);
    setHoverNodeId(id);
  };
  // Grace delay so moving the cursor across the gap from the icon onto the flyout
  // (which re-fires hoverOpen) doesn't close the peek.
  const hoverCloseSoon = (): void => {
    clearTimeout(flyoutTimer.current);
    flyoutTimer.current = setTimeout(() => setHoverNodeId(null), 140);
  };
  const toggleKeepOpen = (id: string): void => {
    clearTimeout(flyoutTimer.current);
    if (heldNodeId === id) {
      // Release; keep a hover peek so it doesn't snap shut under the cursor.
      setHeldNodeId(null);
      setHoverNodeId(id);
    } else {
      setHeldNodeId(id);
      setHoverNodeId(null);
    }
  };
  const dismissFlyout = (): void => {
    clearTimeout(flyoutTimer.current);
    setHeldNodeId(null);
    setHoverNodeId(null);
  };
  const flyoutOpenFor = (id: string): boolean =>
    heldNodeId === id || (heldNodeId === null && hoverNodeId === id);

  // Collapsed → an icon-only rail (hover tooltips). Same actions as the full
  // sidebar, plus the "needs you" sessions as pulsing status dots.
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 bg-flock-surface-1 pb-2">
        <div className="flex h-12 w-full shrink-0 items-center justify-center border-b border-[var(--flock-border)]">
          <SimpleTooltip label="Expand sidebar" side="right">
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={toggleSidebar}
              className="flex size-10 items-center justify-center rounded-md text-flock-ink-muted outline-none hover:bg-flock-surface-2 hover:text-flock-ink-primary focus-visible:bg-flock-surface-2"
            >
              <FlockMark className="size-6" />
            </button>
          </SimpleTooltip>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add"
              className="flex size-10 items-center justify-center rounded-md text-flock-ink-muted outline-none hover:bg-flock-surface-2 hover:text-flock-ink-primary focus-visible:bg-flock-surface-2"
            >
              <Plus className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuLabel>Add</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openDialog('node')}>
              <HardDrive /> New node
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog('project')}>
              <FolderGit2 /> New project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog('session')}>
              <Bot /> New session
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openDialog('race')}>
              <GitCompareArrows /> Race a task…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog('config')}>
              <FileCode2 /> Config (flock.yml)…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="my-0.5 h-px w-6 bg-[var(--flock-border)]" />
        <SidebarLensNav collapsed />
        <div className="my-0.5 h-px w-6 bg-[var(--flock-border)]" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-1">
          {/* Nodes — icon + connection dot; HOVER flies out the node's sessions. */}
          {displayedNodes.map((n) => (
            <NodeRailItem
              key={n.id}
              node={n}
              sessions={openSessionsByNode.get(n.id) ?? EMPTY_SESSIONS}
              statuses={statuses}
              onFocus={select}
              onOpenNode={openNodeInfo}
              open={flyoutOpenFor(n.id)}
              keptOpen={heldNodeId === n.id}
              onHoverOpen={() => hoverOpen(n.id)}
              onHoverCloseSoon={hoverCloseSoon}
              onToggleKeepOpen={() => toggleKeepOpen(n.id)}
              onDismiss={dismissFlyout}
            />
          ))}
          {displayedNodes.length < orderedNodes.length ? (
            <SimpleTooltip
              label={`Show more nodes (${displayedNodes.length} of ${orderedNodes.length})`}
              side="right"
            >
              <button
                type="button"
                aria-label="Show more nodes"
                onClick={() =>
                  setNodeLimit((current) => nextFleetLimit(current, orderedNodes.length))
                }
                className="flex size-10 items-center justify-center rounded-md text-xs font-medium text-flock-accent hover:bg-flock-surface-2"
              >
                +{Math.min(FLEET_PAGE_SIZE, orderedNodes.length - displayedNodes.length)}
              </button>
            </SimpleTooltip>
          ) : null}
          {/* "Needs you" sessions (awaiting_input / error) as pulsing status dots. */}
          {attention.length > 0 && nodes.length > 0 && (
            <div className="my-0.5 h-px w-6 bg-[var(--flock-border)]" />
          )}
          {attention.map((s) => (
            <SimpleTooltip key={s.id} label={sessionLabel(s)} side="right">
              <button
                type="button"
                onClick={() => select(s.id, s.projectId)}
                aria-label={sessionLabel(s)}
                className="flex size-10 items-center justify-center rounded-md outline-none hover:bg-flock-surface-2 focus-visible:bg-flock-surface-2"
              >
                <Dot status={liveStatus(s)} pulse />
              </button>
            </SimpleTooltip>
          ))}
        </div>

        <div className="mt-auto flex flex-col items-center gap-1 border-t border-[var(--flock-border)] pt-2">
          <SimpleTooltip label={`${PRODUCT_NAME} ${FLOCK_VERSION}`} side="right">
            <span className="text-[9px] font-medium text-flock-ink-muted">v{FLOCK_VERSION}</span>
          </SimpleTooltip>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-[var(--flock-border)] bg-flock-surface-1">
      <header className="shrink-0">
        <div className="flex h-12 items-center gap-2 border-b border-[var(--flock-border)] px-4">
          <button
            type="button"
            onClick={() => openMission()}
            aria-label={`${PRODUCT_NAME} home`}
            className="flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-flock-accent"
          >
            <FlockMark className="size-7 shrink-0" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="font-wordmark truncate text-xl font-semibold leading-[18px] text-flock-ink-primary">
                {PRODUCT_NAME}
              </span>
              <span className="mt-0.5 truncate text-[9px] font-medium leading-[9px] tracking-wide text-flock-ink-muted">
                {PRODUCT_TAGLINE}
              </span>
            </span>
          </button>
        </div>
        <div className="space-y-1 p-2">
          <SidebarLensNav />
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="New" className="flex-1 justify-start">
                  <Plus className="size-4" />
                  New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Add</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => openDialog('node')}>
                  <HardDrive /> New node
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDialog('project')}>
                  <FolderGit2 /> New project
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDialog('session')}>
                  <Bot /> New session
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDialog('race')}>
                  <GitCompareArrows /> Race a task…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDialog('config')}>
                  <FileCode2 /> Config (flock.yml)…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openMission()}>
                  <LayoutGrid /> Paddock
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openSettings()}>
                  <Settings /> Settings
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <SimpleTooltip label="Collapse sidebar">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Collapse sidebar"
                onClick={toggleSidebar}
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </SimpleTooltip>
          </div>
        </div>
      </header>

      {/* Agents lens: herdr-style switcher is the primary find path. */}
      {lens === 'agents' ? (
        <div className="min-h-0 flex-1">
          <AgentsSwitcher />
        </div>
      ) : null}

      {lens !== 'agents' ? (
        <>
          {/* Needs attention */}
          {attention.length > 0 && (
            <div className="px-2 pb-2">
              <div className="flex items-center gap-1.5 px-1.5 pb-1">
                <p className="text-xs font-semibold uppercase tracking-label text-flock-ink-muted">
                  Needs you
                </p>
                <Badge variant="neutral" size="sm" data-testid="needs-you-count">
                  {attention.length}
                </Badge>
              </div>
              {attention.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => select(s.id, s.projectId)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-sm text-flock-ink-primary hover:bg-flock-surface-2"
                >
                  <Dot status={liveStatus(s)} pulse />
                  <span className="truncate">{sessionLabel(s)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mx-2 mb-1 h-px bg-[var(--flock-border)]" />

          {/* Tree */}
          <ScrollArea className="min-h-0 flex-1 px-1.5">
            <div className="py-1">
              {!loaded ? (
                <p className="px-2 py-3 text-sm text-flock-ink-muted">Loading…</p>
              ) : nodes.length === 0 ? (
                <div className="px-2 py-4 text-sm text-flock-ink-muted">
                  <p className="mb-2">No nodes yet.</p>
                  <Button size="sm" variant="secondary" onClick={() => openDialog('node')}>
                    <Plus /> Add a node
                  </Button>
                </div>
              ) : nodes.length === 1 ? (
                // Single node: workspace-first (projects at the top, node as a header).
                <SidebarTreeRoot label="Workspace">
                  <WorkspaceList node={nodes[0]!} />
                </SidebarTreeRoot>
              ) : (
                // Multiple nodes: keep the node grouping so "which machine" is clear,
                // with a divider between each node so the groups don't run together.
                <>
                  <SidebarTreeRoot label="Nodes">
                    <div className="divide-y divide-[var(--flock-border)]">
                      {displayedNodes.map((n) => (
                        <NodeRow key={n.id} node={n} onReorder={reorderNode} onMove={moveNode} />
                      ))}
                    </div>
                  </SidebarTreeRoot>
                  {displayedNodes.length < orderedNodes.length ? (
                    <button
                      type="button"
                      onClick={() =>
                        setNodeLimit((current) => nextFleetLimit(current, orderedNodes.length))
                      }
                      className="my-2 w-full rounded-md border border-[var(--flock-border)] px-2 py-2 text-xs font-medium text-flock-accent hover:bg-flock-surface-2"
                    >
                      Show {Math.min(FLEET_PAGE_SIZE, orderedNodes.length - displayedNodes.length)}{' '}
                      more nodes
                      <span className="ml-1 text-flock-ink-muted">
                        ({displayedNodes.length} of {orderedNodes.length})
                      </span>
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </ScrollArea>
        </>
      ) : null}

      <footer className="mt-auto shrink-0 border-t border-[var(--flock-border)] px-3 py-2.5">
        {preferencesSaveState === 'saving' || preferencesSaveState === 'retrying' ? (
          <p className="mb-1 text-2xs text-flock-ink-muted" role="status">
            {preferencesSaveState === 'retrying'
              ? 'Merging workspace changes…'
              : 'Saving workspace…'}
          </p>
        ) : null}
        {preferencesSaveState === 'failed' ? (
          <button
            type="button"
            className="mb-1 flex items-center gap-1 text-left text-2xs text-status-error hover:underline"
            title={preferencesError ?? undefined}
            onClick={retryPreferences}
          >
            <RefreshCw className="size-3" /> Workspace not saved — retry
          </button>
        ) : null}
        <p className="mb-1 text-2xs font-medium text-flock-ink-muted">
          {PRODUCT_NAME} v{FLOCK_VERSION}
        </p>
        <BuiltBy />
      </footer>
    </div>
  );
}
