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
  FolderGit2,
  HardDrive,
  LogOut,
  PanelLeftClose,
  Pin,
  Plus,
  Settings,
  StickyNote,
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
  PopoverTrigger,
  ScrollArea,
  SimpleTooltip,
} from '../../components/ui';
import { FlockMark } from '../../components/SheepIcon';
import { StatusDot as Dot } from '../../components/StatusDot';
import { formatTokens, formatCostUsd } from '../../lib/utils';
import { useAuthOptional } from '../auth/AuthGate';
import { moveBefore, orderSessions, SESSION_DND } from './sessionOrder';
import { ThemeToggle } from '../../theme';
import { usePaddock } from '../../store/paddock';
import {
  useNodes,
  useProjects,
  useSessions,
  useStack,
  useUpdateSession,
} from '../../data/queries';
import { LiveStatusContext, AgentdHealthContext, useLiveStatuses } from './liveData';

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

/**
 * Per-session telemetry line: model · tool · context% · tokens · cost — the same
 * set the grid cell + bottom bar show, so the always-visible roster surfaces the
 * high-value supervision signals (context% = compaction imminent; cost) instead of
 * only tool/tokens. Each field is independently optional (gemini has no tokens but
 * may have a model), so the line renders whenever ANY field is present.
 */
function SessionUsage({ sessionId }: { sessionId: string }): JSX.Element | null {
  const health = useContext(AgentdHealthContext);
  const meta = health?.sessions[sessionId];
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (meta.tool) parts.push(meta.tool);
  if (meta.contextPct != null) parts.push(`${meta.contextPct}% ctx`);
  if (meta.tokens) parts.push(`${formatTokens(meta.tokens)} tok`);
  if (meta.costUsd != null) parts.push(formatCostUsd(meta.costUsd));
  if (parts.length === 0) return null;
  return (
    <span
      className="truncate text-2xs leading-tight text-flock-ink-muted/60"
      data-testid={`session-usage-${sessionId}`}
    >
      {parts.join(' · ')}
    </span>
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

/**
 * The session-row note affordance: a 📝 button that opens an inline popover
 * editor right in the sidebar (no need to open the Activity panel). Always
 * present so you can ADD a note; accent + always-visible once a note exists.
 * Commits on close / Cmd-Enter via the shared update mutation.
 */
function SessionNote({ session }: { session: Session }): JSX.Element {
  const updateSession = useUpdateSession();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(session.note ?? '');
  // Re-sync the draft when the underlying note changes (switching session, or a
  // saved edit echoing back) DURING render instead of in a post-paint effect —
  // same result, one fewer render, no flash of the stale draft. (react.dev:
  // "you might not need an effect" — adjusting state from props.)
  const [syncedNote, setSyncedNote] = useState(session.note);
  if (session.note !== syncedNote) {
    setSyncedNote(session.note);
    setDraft(session.note ?? '');
  }
  const hasNote = !!session.note;
  const save = (): void => {
    const next = draft.trim() === '' ? null : draft;
    if (next !== (session.note ?? null)) updateSession.mutate({ id: session.id, patch: { note: next } });
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) save();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={hasNote ? 'Edit note' : 'Add note'}
          title={hasNote ? (session.note ?? undefined) : 'Add note'}
          data-testid={`session-note-${session.id}`}
          className={
            hasNote
              ? 'shrink-0 text-flock-accent'
              : 'shrink-0 opacity-0 transition-opacity group-hover/srow:opacity-100 hover:text-flock-ink-primary'
          }
        >
          <StickyNote className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-flock-ink-muted">
          Note · {sessionLabel(session)}
        </p>
        <textarea
          autoFocus
          data-testid={`session-note-input-${session.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              save();
              setOpen(false);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          rows={4}
          placeholder="What is this session working on?"
          className="w-full resize-y rounded border border-flock-muted/25 bg-transparent px-2 py-1.5 text-sm text-flock-ink-primary placeholder:text-flock-ink-muted/60 focus:border-flock-accent focus:outline-none"
        />
        <p className="mt-1 text-2xs text-flock-ink-muted/70">⌘/Ctrl+Enter to save · Esc to close</p>
      </PopoverContent>
    </Popover>
  );
}

function SessionRow({
  session,
  onReorder,
}: {
  session: Session;
  onReorder: (fromId: string, toId: string) => void;
}): JSX.Element {
  const selected = usePaddock((s) => s.selectedSessionId === session.id);
  // Opening a session from the sidebar MAXIMIZES it (focus view) — not a 1-cell grid.
  const select = usePaddock((s) => s.focusSession);
  const openDialog = usePaddock((s) => s.openDialog);
  // Terminate is destructive (kills the agent) — confirm first.
  const confirmTerminate = (id: string) => openDialog('terminate-session', { sessionId: id });
  const status = useLiveStatus(session);
  const updateSession = useUpdateSession();
  const togglePin = () =>
    updateSession.mutate({ id: session.id, patch: { pinned: !session.pinned } });
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DND, session.id);
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
          onReorder(from, session.id);
        }
      }}
      className={`group/srow flex items-center gap-2 rounded-md py-1 pl-7 pr-1.5 text-sm transition-colors ${
        selected
          ? 'bg-flock-accent/12 text-flock-ink-primary'
          : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
      }`}
    >
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
                className={`shrink-0 rounded bg-flock-surface-2 px-1 text-[9px] font-semibold leading-tight tracking-label ${MODE_BADGE[session.permissionMode]!.cls}`}
              >
                {MODE_BADGE[session.permissionMode]!.label}
              </span>
            ) : null}
          </span>
          <span
            className={`truncate text-2xs leading-tight ${statusTextClass(status)}`}
            data-testid={`session-status-${session.id}`}
          >
            {statusLabel(status)}
          </span>
          <SessionUsage sessionId={session.id} />
        </span>
      </button>
      <SessionNote session={session} />
      <button
        type="button"
        aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
        aria-pressed={session.pinned}
        onClick={togglePin}
        data-testid={`session-pin-${session.id}`}
        className={
          session.pinned
            ? 'shrink-0 text-flock-accent'
            : 'shrink-0 opacity-0 transition-opacity group-hover/srow:opacity-100 hover:text-flock-accent'
        }
      >
        <Pin className={`size-3.5 ${session.pinned ? 'fill-current' : ''}`} />
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
  const sessionOrder = usePaddock((s) => s.sessionOrder);
  const setSessionOrder = usePaddock((s) => s.setSessionOrder);
  // The user's manual drag order (shared with the top tabs + grid panes); new
  // sessions not yet ordered fall to the end. Pin is a marker now, not a sort.
  const sessions = useMemo(
    () => orderSessions(allSessions.filter((x) => x.projectId === project.id), sessionOrder[project.id]),
    [allSessions, project.id, sessionOrder],
  );
  const reorder = (fromId: string, toId: string): void =>
    setSessionOrder(project.id, moveBefore(sessions.map((s) => s.id), fromId, toId));
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
        <SimpleTooltip label="New session">
          <button
            type="button"
            aria-label="New session"
            onClick={() => openDialog('session', { projectId: project.id })}
            className="opacity-0 transition-opacity group-hover/prow:opacity-100 hover:text-flock-accent"
          >
            <Plus className="size-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      {open && (
        <div className="mt-0.5">
          {sessions.length === 0 ? (
            <p className="py-1 pl-7 text-2xs text-flock-ink-muted/70">No sessions</p>
          ) : (
            sessions.map((s) => <SessionRow key={s.id} session={s} onReorder={reorder} />)
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({ node }: { node: FlockNode }): JSX.Element {
  const { data: allProjects = [] } = useProjects();
  const projects = useMemo(
    () => allProjects.filter((p) => p.nodeId === node.id),
    [allProjects, node.id],
  );
  const openDialog = usePaddock((s) => s.openDialog);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const [open, setOpen] = useState(true);
  const connected = node.connectionStatus === 'connected';
  return (
    <div className="mb-1">
      <div className="group/nrow flex items-center gap-1.5 rounded-md px-1.5 py-1.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-flock-ink-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-flock-ink-muted" />}
          <HardDrive className={`size-3.5 shrink-0 ${connected ? 'text-status-idle' : 'text-flock-ink-muted'}`} />
          <span className="truncate text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">{node.name}</span>
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
        <SimpleTooltip label="New project">
          <button
            type="button"
            aria-label="New project"
            onClick={() => openDialog('project', { nodeId: node.id })}
            className="opacity-0 transition-opacity group-hover/nrow:opacity-100 hover:text-flock-accent"
          >
            <Plus className="size-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      {open && (
        <div>
          {projects.length === 0 ? (
            <p className="py-1 pl-7 text-2xs text-flock-ink-muted/70">No projects</p>
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
      <div className="group/nrow flex items-center gap-1.5 px-1.5 py-1.5">
        <HardDrive className={`size-3.5 shrink-0 ${connected ? 'text-status-idle' : 'text-flock-ink-muted'}`} />
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
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
        <SimpleTooltip label="New project">
          <button
            type="button"
            aria-label="New project"
            onClick={() => openDialog('project', { nodeId: node.id })}
            className="opacity-0 transition-opacity group-hover/nrow:opacity-100 hover:text-flock-accent"
          >
            <Plus className="size-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      {projects.length === 0 ? (
        <p className="py-1 pl-7 text-2xs text-flock-ink-muted/70">No projects</p>
      ) : (
        projects.map((p) => <ProjectRow key={p.id} project={p} />)
      )}
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
  const openDialog = usePaddock((s) => s.openDialog);
  const openSettings = usePaddock((s) => s.openSettings);
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
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="my-0.5 h-px w-6 bg-[var(--flock-border)]" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-1">
          {/* Nodes — icon + connection dot; HOVER flies out the node's sessions. */}
          {nodes.map((n) => (
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
          <ThemeToggle />
          <SimpleTooltip label="Settings" side="right">
            <Button size="icon-sm" variant="ghost" aria-label="Settings" onClick={() => openSettings()}>
              <Settings className="size-4" />
            </Button>
          </SimpleTooltip>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-flock-surface-1">
      {/* Brand + global add */}
      <header className="flex items-center gap-2 px-3 py-3">
        <FlockMark className="size-7" />
        <span className="text-lg font-semibold tracking-tight text-flock-ink-primary">Flock</span>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openSettings()}>
                <Settings /> Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Needs attention */}
      {attention.length > 0 && (
        <div className="px-2 pb-2">
          <p className="px-1.5 pb-1 text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
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
            // Multiple nodes: keep the node grouping so "which machine" is clear.
            nodes.map((n) => <NodeRow key={n.id} node={n} />)
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <footer className="flex items-center justify-between gap-2 border-t border-[var(--flock-border)] px-3 py-2">
        <UserMenu />
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <SimpleTooltip label="Settings">
            <Button size="icon-sm" variant="ghost" aria-label="Settings" onClick={() => openSettings()}>
              <Settings className="size-4" />
            </Button>
          </SimpleTooltip>
        </div>
      </footer>
    </div>
  );
}

/** A compact display name (email local part) + initials for the avatar chip. */
function shortName(username: string): string {
  return (username.split('@')[0] || username).trim();
}
function initials(username: string): string {
  const base = shortName(username);
  const parts = base.split(/[.\-_+\s]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : base.slice(0, 2);
  return letters.toUpperCase() || '?';
}

/**
 * Footer account chip: a small initials avatar + short name (not the full email,
 * which is long); the dropdown shows the full address and → Account / Sign out.
 * Uses the optional auth hook so the chrome still renders outside AuthGate (tests).
 */
function UserMenu(): JSX.Element | null {
  const auth = useAuthOptional();
  const openSettings = usePaddock((s) => s.openSettings);
  if (!auth) return null;
  const { user, logout } = auth;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          title={user.username}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-flock-surface-2"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-flock-accent text-2xs font-semibold text-white">
            {initials(user.username)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-flock-ink-primary">{shortName(user.username)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-flock-ink-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="truncate" title={user.username}>
          {user.username}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings('account')}>
          <Settings /> Account settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
