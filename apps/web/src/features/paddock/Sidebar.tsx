/**
 * Sidebar — the supervision tree + navigation (Codex left rail).
 *
 * Brand + global "add" menu at the top, a "needs attention" shortcut list, the
 * collapsible node → project → session tree (the FR-UI3 supervision dashboard),
 * and a footer with theme + settings. Status is conveyed by the small flock
 * status dot, never a loud badge (Appendix A.4 calm density).
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileCode2,
  FolderGit2,
  FolderPlus,
  GitCompareArrows,
  GripVertical,
  HardDrive,
  LayoutGrid,
  PanelLeftClose,
  Pin,
  Plus,
  Settings,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { statusLabel, type AgentType, type Node as FlockNode, type Project, type Session, type SessionPermissionMode, type Status } from '@flock/shared';
import {
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
import { FlockMark } from '../../components/SheepIcon';
import { StatusDot as Dot } from '../../components/StatusDot';
import { usePaddock, orderNodes } from '../../store/paddock';
import { useNodes, useProjects, useSessions, useStack } from '../../data/queries';
import { LiveStatusContext, AgentdHealthContext, useLiveStatuses } from './liveData';
import { isShellProcess } from '../../lib/utils';

/** A session's live status if the status WS has reported one, else its REST value. */
function useLiveStatus(session: Session): Status {
  return useContext(LiveStatusContext).get(session.id) ?? session.status;
}

const AGENT_SHORT: Record<AgentType, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  grok: 'Grok',
  aider: 'Aider',
  'cursor-agent': 'Cursor',
  amp: 'Amp',
  generic: 'Agent',
  terminal: 'Terminal',
  dev: 'Dev',
};

/** Stable empty list so nodes with no sessions don't get a fresh array each render. */
const EMPTY_SESSIONS: Session[] = [];

/**
 * Permission-mode badge for a session row — the at-a-glance safety signal of how
 * autonomous an agent is. `default` (asks before edits) is the safe norm and gets
 * NO badge; the riskier modes are flagged, autonomous most loudly.
 */
const MODE_BADGE: Partial<Record<SessionPermissionMode, { label: string; title: string; cls: string }>> = {
  plan: { label: 'PLAN', title: 'Plan mode — read-only until you approve', cls: 'text-flock-accent' },
  acceptEdits: { label: 'AUTO', title: 'Auto-accept edits', cls: 'text-status-awaiting' },
  autonomous: { label: 'YOLO', title: 'Autonomous — no approval prompts', cls: 'text-status-error' },
};

/** Sort rank by status: the agents that need you float to the top of the sidebar. */
const STATUS_RANK: Record<string, number> = {
  awaiting_input: 0,
  error: 1,
  running: 2,
  starting: 3,
  idle: 4,
  done: 5,
  disconnected: 6,
};

/** Tailwind bg for a node's connection status — the little dot on the rail's node icon. */
const NODE_CONN_BG: Record<string, string> = {
  connected: 'bg-status-idle',
  connecting: 'bg-status-awaiting',
  disconnected: 'bg-status-disconnected',
  error: 'bg-status-error',
};

/** The small themed status dot (driven by theme.css `.flock-status-dot`). */
/**
 * Per-session connection dot: GREEN when the session's PTY is actually running on
 * the node daemon (connected & communicating), AMBER while the link is up but the
 * PTY isn't live yet (starting/exited), RED when the daemon link is down. Renders
 * nothing for sessions the daemon doesn't own (local/tmux), so it never lies.
 */
function SessionConn({ session }: { session: Session }): JSX.Element | null {
  const health = useContext(AgentdHealthContext);
  if (!health?.enabled) return null;
  const sess = health.sessions[session.id];
  if (!sess) return null; // not an agentd session (local/tmux), or not yet tracked
  const linkUp = health.nodes[session.nodeId]?.link === 'up';
  const state = sess.live ? 'connected' : linkUp ? 'connecting' : 'down';
  const cls =
    state === 'connected'
      ? 'text-status-idle'
      : state === 'connecting'
        ? 'text-status-awaiting'
        : 'text-status-error';
  const label =
    state === 'connected'
      ? 'Agent connected'
      : state === 'connecting'
        ? 'Connecting to agent…'
        : 'Agent disconnected';
  return (
    <SimpleTooltip label={label}>
      <span className={`flex shrink-0 items-center ${cls}`} data-testid={`session-conn-${session.id}`} data-conn={state}>
        {state === 'down' ? (
          <WifiOff className="size-3" />
        ) : (
          <Wifi className={`size-3 ${state === 'connecting' ? 'animate-flock-pulse' : ''}`} />
        )}
      </span>
    </SimpleTooltip>
  );
}

/** Per-node daemon-link dot for ssh nodes (green when the daemon link is live). */
function NodeConn({ node }: { node: FlockNode }): JSX.Element | null {
  const health = useContext(AgentdHealthContext);
  if (!health?.enabled || node.kind !== 'ssh') return null;
  const up = health.nodes[node.id]?.link === 'up';
  return (
    <SimpleTooltip label={up ? 'flock-agentd connected' : 'flock-agentd link not established'}>
      <span
        className={`flex shrink-0 items-center ${up ? 'text-status-idle' : 'text-flock-ink-muted/60'}`}
        data-testid={`node-conn-${node.id}`}
        data-conn={up ? 'up' : 'down'}
      >
        {up ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
      </span>
    </SimpleTooltip>
  );
}

function sessionLabel(s: Session): string {
  return `${AGENT_SHORT[s.agentType]} · ${s.id.slice(0, 6)}`;
}

/** Tint the status line for the two states the user must act on; calm otherwise. */
function statusTextClass(status: string): string {
  if (status === 'awaiting_input') return 'text-status-awaiting';
  if (status === 'error') return 'text-status-error';
  return 'text-flock-ink-muted/70';
}

function SessionRow({ session }: { session: Session }): JSX.Element {
  const selected = usePaddock((s) => s.selectedSessionId === session.id);
  // Opening a session from the sidebar MAXIMIZES it (focus view) — not a 1-cell grid.
  const select = usePaddock((s) => s.focusSession);
  const openDialog = usePaddock((s) => s.openDialog);
  // Terminate is destructive (kills the agent) — confirm first.
  const confirmTerminate = (id: string) => openDialog('terminate-session', { sessionId: id });
  const status = useLiveStatus(session);
  // For a plain terminal, surface the live FOREGROUND process (htop/vim/…) in
  // place of the bare status — the daemon reports it as the session's `tool`.
  const health = useContext(AgentdHealthContext);
  const fg = session.agentType === 'terminal' ? health?.sessions[session.id]?.tool : undefined;
  const foreground = fg && !isShellProcess(fg) ? fg : null;
  return (
    <div
      className={`group/srow relative flex items-center gap-2 rounded-md py-1 pl-7 pr-1.5 text-sm transition-colors ${
        selected
          ? 'bg-flock-accent/12 text-flock-ink-primary'
          : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
      }`}
    >
      {selected ? (
        <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-flock-accent" />
      ) : null}
      <button
        type="button"
        onClick={() => select(session.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        data-testid={`session-${session.id}`}
      >
        <Dot status={status} pulse={status === 'awaiting_input'} />
        <SessionConn session={session} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate leading-tight">{sessionLabel(session)}</span>
            {MODE_BADGE[session.permissionMode] ? (
              <span
                title={MODE_BADGE[session.permissionMode]!.title}
                className={`shrink-0 rounded bg-flock-surface-2 px-1 text-[10px] font-semibold leading-tight tracking-label ${MODE_BADGE[session.permissionMode]!.cls}`}
              >
                {MODE_BADGE[session.permissionMode]!.label}
              </span>
            ) : null}
          </span>
          <span
            className={`truncate text-xs leading-tight ${foreground ? 'text-flock-ink-muted' : statusTextClass(status)}`}
            data-testid={`session-status-${session.id}`}
            title={foreground ? `Running: ${foreground}` : undefined}
          >
            {foreground ?? statusLabel(status)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Terminate session"
        onClick={() => confirmTerminate(session.id)}
        className="shrink-0 opacity-0 transition-opacity group-hover/srow:opacity-100 hover:text-status-error"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Human labels for detected stack ids (from /api/nodes/:id/stack). */
const STACK_LABELS: Record<string, string> = {
  node: 'Node', deno: 'Deno', rust: 'Rust', go: 'Go', python: 'Python',
  laravel: 'Laravel', php: 'PHP', rails: 'Rails', ruby: 'Ruby',
  maven: 'Java', gradle: 'Gradle', docker: 'Docker',
};

/** Small auto-detected tech-stack badges on a project row (hiteterm-style). */
function StackBadges({ project }: { project: Project }): JSX.Element | null {
  const { data } = useStack(project.nodeId, project.workingDir);
  const stacks = data?.stacks ?? [];
  if (stacks.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label="Detected stacks">
      {stacks.slice(0, 3).map((s) => (
        <span
          key={s}
          className="rounded bg-flock-surface-2 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-flock-ink-muted"
          data-testid={`stack-${s}`}
        >
          {STACK_LABELS[s] ?? s}
        </span>
      ))}
    </span>
  );
}

function ProjectRow({ project }: { project: Project }): JSX.Element {
  const { data: allSessions = [] } = useSessions();
  const live = useLiveStatuses();
  // Auto-sorted by live status — the agents that NEED YOU float to the top, no
  // manual pinning/reordering to fuss with.
  const sessions = useMemo(
    () =>
      [...allSessions.filter((x) => x.projectId === project.id)].sort(
        (a, b) =>
          (STATUS_RANK[live.get(a.id) ?? a.status] ?? 9) - (STATUS_RANK[live.get(b.id) ?? b.status] ?? 9),
      ),
    [allSessions, project.id, live],
  );
  const openDialog = usePaddock((s) => s.openDialog);
  const selectProject = usePaddock((s) => s.selectProject);
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="group/prow flex items-center gap-1.5 rounded-md py-1 pl-4 pr-1.5 text-sm text-flock-ink-primary hover:bg-flock-surface-2">
        {/* Clicking a project both expands it AND scopes the grid to it (its
            `/p/:id` URL) — the side-by-side view of just that project. */}
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            selectProject(project.id);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? <ChevronDown className="size-3.5 shrink-0 text-flock-ink-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-flock-ink-muted" />}
          <FolderGit2 className="size-3.5 shrink-0 text-flock-ink-muted" />
          <span className="truncate font-medium">{project.name}</span>
          <StackBadges project={project} />
        </button>
        <SimpleTooltip label="New session (launch an agent here)">
          <button
            type="button"
            aria-label="New session"
            onClick={() => openDialog('session', { projectId: project.id })}
            className="opacity-0 transition-opacity group-hover/prow:opacity-100 hover:text-flock-accent"
          >
            <Bot className="size-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      {open && (
        <div className="mt-0.5">
          {sessions.length === 0 ? (
            <p className="py-1 pl-7 text-xs text-flock-ink-muted/70">No sessions</p>
          ) : (
            sessions.map((s) => <SessionRow key={s.id} session={s} />)
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({
  node,
  onReorder,
}: {
  node: FlockNode;
  onReorder: (draggedId: string, targetId: string) => void;
}): JSX.Element {
  const { data: allProjects = [] } = useProjects();
  const projects = useMemo(
    () => allProjects.filter((p) => p.nodeId === node.id),
    [allProjects, node.id],
  );
  const openDialog = usePaddock((s) => s.openDialog);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const connected = node.connectionStatus === 'connected';
  return (
    <div className="py-1.5">
      {/* Host header BAND — a faint surface band so a node reads as a section header,
          clearly a different level from the project/session items nested under it.
          Drag the grip handle to reorder; the band is the drop target. */}
      <div
        className={`group/nrow flex items-center gap-1.5 rounded-md px-1.5 py-1.5 ring-1 ${dragOver ? 'ring-2 ring-flock-accent' : 'ring-white/[0.03]'}`}
        style={{ backgroundColor: 'color-mix(in srgb, var(--flock-surface-2) 70%, transparent)' }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const id = e.dataTransfer.getData('flock/node');
          if (id) onReorder(id, node.id);
        }}
      >
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('flock/node', node.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          title="Drag to reorder nodes"
          aria-label="Drag to reorder"
          className="shrink-0 cursor-grab text-flock-ink-muted/40 opacity-0 transition-opacity hover:text-flock-ink-muted group-hover/nrow:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-flock-ink-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-flock-ink-muted" />}
          <HardDrive className={`size-3.5 shrink-0 ${connected ? 'text-status-idle' : 'text-flock-ink-muted'}`} />
          <span className="truncate text-xs font-semibold uppercase tracking-label text-flock-ink-muted">{node.name}</span>
          {node.pool ? (
            <span
              className="shrink-0 rounded-full bg-flock-surface-3 px-1.5 text-[0.625rem] font-medium normal-case tracking-normal text-flock-ink-muted"
              title={`Pool: ${node.pool}`}
            >
              {node.pool}
            </span>
          ) : null}
          <NodeConn node={node} />
        </button>
        <SimpleTooltip label="Node info (CPU / memory / agents)">
          <button
            type="button"
            aria-label="Node info"
            onClick={() => openNodeInfo(node.id)}
            className="opacity-0 transition-opacity group-hover/nrow:opacity-100 hover:text-flock-accent"
          >
            <Cpu className="size-3.5" />
          </button>
        </SimpleTooltip>
        <SimpleTooltip label="New project (add a repo on this node)">
          <button
            type="button"
            aria-label="New project"
            onClick={() => openDialog('project', { nodeId: node.id })}
            className="opacity-0 transition-opacity group-hover/nrow:opacity-100 hover:text-flock-accent"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      {open && (
        // Tree guide — a vertical line ties the node's projects/sessions to their host.
        <div className="ml-3 mt-0.5 border-l border-[var(--flock-border)]">
          {projects.length === 0 ? (
            <p className="py-1 pl-4 text-xs text-flock-ink-muted/70">No projects</p>
          ) : (
            projects.map((p) => <ProjectRow key={p.id} project={p} />)
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Workspace-first tree for the SINGLE-node case (hive-style): projects are the
 * top level (the node is just a slim header + health chip), so there's no
 * redundant node nesting. Multi-node keeps the node→project grouping (NodeRow).
 */
function WorkspaceList({ node }: { node: FlockNode }): JSX.Element {
  const { data: allProjects = [] } = useProjects();
  const projects = useMemo(
    () => allProjects.filter((p) => p.nodeId === node.id),
    [allProjects, node.id],
  );
  const openDialog = usePaddock((s) => s.openDialog);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const connected = node.connectionStatus === 'connected';
  return (
    <div>
      <div
        className="group/nrow flex items-center gap-1.5 rounded-md px-1.5 py-1.5 ring-1 ring-white/[0.03]"
        style={{ backgroundColor: 'color-mix(in srgb, var(--flock-surface-2) 70%, transparent)' }}
      >
        <HardDrive className={`size-3.5 shrink-0 ${connected ? 'text-status-idle' : 'text-flock-ink-muted'}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-label text-flock-ink-muted">
          {node.name}
        </span>
        <NodeConn node={node} />
        <SimpleTooltip label="Node info (CPU / memory / agents)">
          <button
            type="button"
            aria-label="Node info"
            onClick={() => openNodeInfo(node.id)}
            className="opacity-0 transition-opacity group-hover/nrow:opacity-100 hover:text-flock-accent"
          >
            <Cpu className="size-3.5" />
          </button>
        </SimpleTooltip>
        <SimpleTooltip label="New project (add a repo on this node)">
          <button
            type="button"
            aria-label="New project"
            onClick={() => openDialog('project', { nodeId: node.id })}
            className="opacity-0 transition-opacity group-hover/nrow:opacity-100 hover:text-flock-accent"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      <div className="ml-3 mt-0.5 border-l border-[var(--flock-border)]">
        {projects.length === 0 ? (
          <p className="py-1 pl-4 text-2xs text-flock-ink-muted/70">No projects</p>
        ) : (
          projects.map((p) => <ProjectRow key={p.id} project={p} />)
        )}
      </div>
    </div>
  );
}

/**
 * A node in the COLLAPSED rail: an icon (Cpu/HardDrive + connection dot) whose
 * flyout panel (that node's open sessions + "Node details") opens on HOVER (a
 * peek that auto-closes when you leave) AND can be PINNED open via the icon click
 * or the header pin button — pinned stays open until you close it (button / click
 * the icon again / Esc / click outside). VS Code-style peek, no layout shift.
 *
 * Open/pinned state is OWNED by the rail (single source of truth) so only one
 * flyout is ever open and hovering another node switches instantly. Uses
 * PopoverAnchor (not Trigger) so the icon's click is OURS (toggle pin), not
 * Radix's built-in open toggle.
 */
function NodeRailItem({
  node,
  sessions,
  statuses,
  onFocus,
  onOpenNode,
  open,
  pinned,
  onHoverOpen,
  onHoverCloseSoon,
  onTogglePin,
  onDismiss,
}: {
  node: FlockNode;
  sessions: Session[];
  statuses: ReadonlyMap<string, Status>;
  onFocus: (id: string) => void;
  onOpenNode: (id: string) => void;
  open: boolean;
  pinned: boolean;
  onHoverOpen: () => void;
  onHoverCloseSoon: () => void;
  onTogglePin: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const NodeIcon = node.kind === 'local' ? Cpu : HardDrive;
  return (
    <Popover open={open} onOpenChange={(o) => !o && onDismiss()}>
      <PopoverAnchor asChild>
        <button
          type="button"
          onClick={onTogglePin}
          onMouseEnter={onHoverOpen}
          onMouseLeave={onHoverCloseSoon}
          aria-label={`${node.name} (${node.connectionStatus})`}
          aria-pressed={pinned}
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
          {/* Pin (keep open) ⇄ Close — the persistent open/close button. */}
          <button
            type="button"
            onClick={pinned ? onDismiss : onTogglePin}
            aria-label={pinned ? 'Close' : 'Keep open'}
            title={pinned ? 'Close' : 'Keep open'}
            className={`shrink-0 rounded p-0.5 hover:bg-flock-surface-2 hover:text-flock-ink-primary ${pinned ? 'text-flock-ink-primary' : 'text-flock-ink-muted'}`}
          >
            {pinned ? <X className="size-3.5" /> : <Pin className="size-3.5" />}
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
                    onFocus(s.id);
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
  const reorderNode = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return;
    const ids = orderedNodes.map((n) => n.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);
    setNodeOrder(ids);
  };
  const openDialog = usePaddock((s) => s.openDialog);
  const openSettings = usePaddock((s) => s.openSettings);
  const openOverview = usePaddock((s) => s.openOverview);
  const view = usePaddock((s) => s.view);
  // "Needs you" / session clicks MAXIMIZE the session (focus view), not a 1-cell grid.
  const select = usePaddock((s) => s.focusSession);
  const collapsed = usePaddock((s) => s.sidebarCollapsed);
  const toggleSidebar = usePaddock((s) => s.toggleSidebar);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);

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
  //  - pinnedNodeId: a PINNED flyout (icon click / pin button) that stays open
  //    until explicitly closed. While something is pinned, hover is ignored.
  // A node's flyout is open when it's pinned, OR (nothing pinned and) it's hovered.
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(null);
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
  const togglePin = (id: string): void => {
    clearTimeout(flyoutTimer.current);
    if (pinnedNodeId === id) {
      // Un-pin; keep a hover peek so it doesn't snap shut under the cursor.
      setPinnedNodeId(null);
      setHoverNodeId(id);
    } else {
      setPinnedNodeId(id);
      setHoverNodeId(null);
    }
  };
  const dismissFlyout = (): void => {
    clearTimeout(flyoutTimer.current);
    setPinnedNodeId(null);
    setHoverNodeId(null);
  };
  const flyoutOpenFor = (id: string): boolean =>
    pinnedNodeId === id || (pinnedNodeId === null && hoverNodeId === id);

  // Collapsed → an icon-only rail (hover tooltips). Same actions as the full
  // sidebar, plus the "needs you" sessions as pulsing status dots.
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 bg-flock-surface-1 py-2">
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
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-1">
          {/* Nodes — icon + connection dot; HOVER flies out the node's sessions. */}
          {orderedNodes.map((n) => (
            <NodeRailItem
              key={n.id}
              node={n}
              sessions={openSessionsByNode.get(n.id) ?? EMPTY_SESSIONS}
              statuses={statuses}
              onFocus={select}
              onOpenNode={openNodeInfo}
              open={flyoutOpenFor(n.id)}
              pinned={pinnedNodeId === n.id}
              onHoverOpen={() => hoverOpen(n.id)}
              onHoverCloseSoon={hoverCloseSoon}
              onTogglePin={() => togglePin(n.id)}
              onDismiss={dismissFlyout}
            />
          ))}
          {/* "Needs you" sessions (awaiting_input / error) as pulsing status dots. */}
          {attention.length > 0 && nodes.length > 0 && (
            <div className="my-0.5 h-px w-6 bg-[var(--flock-border)]" />
          )}
          {attention.map((s) => (
            <SimpleTooltip key={s.id} label={sessionLabel(s)} side="right">
              <button
                type="button"
                onClick={() => select(s.id)}
                aria-label={sessionLabel(s)}
                className="flex size-10 items-center justify-center rounded-md outline-none hover:bg-flock-surface-2 focus-visible:bg-flock-surface-2"
              >
                <Dot status={liveStatus(s)} pulse />
              </button>
            </SimpleTooltip>
          ))}
        </div>

        <div className="mt-auto flex flex-col items-center gap-1 border-t border-[var(--flock-border)] pt-2">
          <SimpleTooltip label="Paddock" side="right">
            <Button size="icon-sm" variant="ghost" aria-label="Paddock" onClick={() => openOverview()}>
              <LayoutGrid className="size-4" />
            </Button>
          </SimpleTooltip>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-[var(--flock-border)] bg-flock-surface-1">
      {/* Section label + global add — clicking returns to the Paddock home. */}
      <header className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => openOverview()}
          aria-label="Paddock (home)"
          title="Paddock (home)"
          className="rounded-md px-1 py-0.5 text-xs font-semibold uppercase tracking-label text-flock-ink-muted outline-none hover:text-flock-ink-primary focus-visible:ring-1 focus-visible:ring-flock-accent"
        >
          Paddock
        </button>
        <div className="ml-auto flex items-center gap-1">
          <SimpleTooltip label="Collapse sidebar">
            <Button size="icon-sm" variant="ghost" aria-label="Collapse sidebar" onClick={toggleSidebar}>
              <PanelLeftClose className="size-4" />
            </Button>
          </SimpleTooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Add">
                <Plus className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
              <DropdownMenuItem onSelect={() => openOverview()}>
                <LayoutGrid /> Paddock
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openSettings()}>
                <Settings /> Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Primary nav: back to the Paddock home (the fleet). */}
      <div className="px-2 pb-1">
        <button
          type="button"
          onClick={() => openOverview()}
          aria-current={view === 'overview'}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
            view === 'overview'
              ? 'bg-flock-accent/15 text-flock-accent ring-1 ring-flock-accent/30'
              : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
          }`}
        >
          <LayoutGrid className="size-4" /> Paddock
        </button>
      </div>

      {/* Needs attention */}
      {attention.length > 0 && (
        <div className="px-2 pb-2">
          <p className="px-1.5 pb-1 text-xs font-semibold uppercase tracking-label text-flock-ink-muted">
            Needs you
          </p>
          {attention.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => select(s.id)}
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
            <WorkspaceList node={nodes[0]!} />
          ) : (
            // Multiple nodes: keep the node grouping so "which machine" is clear,
            // with a divider between each node so the groups don't run together.
            <div className="divide-y divide-[var(--flock-border)]">
              {orderedNodes.map((n) => (
                <NodeRow key={n.id} node={n} onReorder={reorderNode} />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

    </div>
  );
}

