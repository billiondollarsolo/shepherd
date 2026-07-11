import { useContext, useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderGit2,
  FolderPlus,
  GripVertical,
  HardDrive,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  statusLabel,
  type Node as FlockNode,
  type Project,
  type Session,
  type Status,
} from '@flock/shared';
import { SimpleTooltip } from '../../components/ui';
import { StatusDot as Dot } from '../../components/StatusDot';
import { usePaddock } from '../../store/paddock';
import { useProjects, useSessions, useStack } from '../../data/queries';
import { AgentdHealthContext, LiveStatusContext, useLiveStatuses } from './liveData';
import { isShellProcess } from '../../lib/utils';
import { MODE_BADGE, STATUS_RANK, sessionLabel } from './sidebarModel';

function useLiveStatus(session: Session): Status {
  return useContext(LiveStatusContext).get(session.id) ?? session.status;
}

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
      <span
        className={`flex shrink-0 items-center ${cls}`}
        data-testid={`session-conn-${session.id}`}
        data-conn={state}
      >
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

function statusTextClass(status: string): string {
  if (status === 'awaiting_input') return 'text-status-awaiting';
  if (status === 'error') return 'text-status-error';
  return 'text-flock-ink-muted/70';
}

function SessionRow({ session }: { session: Session }): JSX.Element {
  const selected = usePaddock((s) => s.selectedSessionId === session.id);
  // Opening a session from the sidebar MAXIMIZES it (focus view) — not a 1-cell grid.
  const select = usePaddock((s) => s.openAgent);
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
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-flock-accent"
        />
      ) : null}
      <button
        type="button"
        onClick={() => select(session.id, session.projectId)}
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
  node: 'Node',
  deno: 'Deno',
  rust: 'Rust',
  go: 'Go',
  python: 'Python',
  laravel: 'Laravel',
  php: 'PHP',
  rails: 'Rails',
  ruby: 'Ruby',
  maven: 'Java',
  gradle: 'Gradle',
  docker: 'Docker',
};

/** Small auto-detected tech-stack badges on a project row (hiteterm-style). */
function StackBadges({
  project,
  nodeConnected,
}: {
  project: Project;
  nodeConnected: boolean;
}): JSX.Element | null {
  const { data } = useStack(project.nodeId, project.workingDir, nodeConnected);
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

function ProjectRow({
  project,
  nodeConnected,
}: {
  project: Project;
  nodeConnected: boolean;
}): JSX.Element {
  const { data: allSessions = [] } = useSessions();
  const live = useLiveStatuses();
  // Auto-sorted by live status — the agents that NEED YOU float to the top, no
  // manual pinning/reordering to fuss with.
  const sessions = useMemo(
    () =>
      [...allSessions.filter((x) => x.projectId === project.id)].sort(
        (a, b) =>
          (STATUS_RANK[live.get(a.id) ?? a.status] ?? 9) -
          (STATUS_RANK[live.get(b.id) ?? b.status] ?? 9),
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
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-flock-ink-muted" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-flock-ink-muted" />
          )}
          <FolderGit2 className="size-3.5 shrink-0 text-flock-ink-muted" />
          <span className="truncate font-medium">{project.name}</span>
          <StackBadges project={project} nodeConnected={nodeConnected} />
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

export function NodeRow({
  node,
  onReorder,
  onMove,
}: {
  node: FlockNode;
  onReorder: (draggedId: string, targetId: string) => void;
  onMove: (nodeId: string, direction: -1 | 1) => void;
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
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          aria-expanded={open}
          className="shrink-0 text-flock-ink-muted hover:text-flock-ink-primary"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-flock-ink-muted" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-flock-ink-muted" />
          )}
        </button>
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('flock/node', node.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onKeyDown={(event) => {
            if (!event.altKey) return;
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              onMove(node.id, -1);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              onMove(node.id, 1);
            }
          }}
          title="Drag to reorder nodes; Alt+Up/Down also moves this node"
          aria-label={`Reorder ${node.name}; use Alt+Up or Alt+Down`}
          className="shrink-0 cursor-grab text-flock-ink-muted/50 opacity-60 transition-opacity hover:text-flock-ink-muted hover:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <HardDrive
            className={`size-3.5 shrink-0 ${connected ? 'text-status-idle' : 'text-flock-ink-muted'}`}
          />
          <span className="truncate text-xs font-semibold uppercase tracking-label text-flock-ink-muted">
            {node.name}
          </span>
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
            projects.map((p) => <ProjectRow key={p.id} project={p} nodeConnected={connected} />)
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
export function WorkspaceList({ node }: { node: FlockNode }): JSX.Element {
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
        <HardDrive
          className={`size-3.5 shrink-0 ${connected ? 'text-status-idle' : 'text-flock-ink-muted'}`}
        />
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
          projects.map((p) => <ProjectRow key={p.id} project={p} nodeConnected={connected} />)
        )}
      </div>
    </div>
  );
}

/**
 * A node in the COLLAPSED rail: an icon (Cpu/HardDrive + connection dot) whose
 * flyout panel (that node's open sessions + "Node details") opens on HOVER (a
 * peek that auto-closes when you leave) AND can be PINNED open via the icon click
 * or the header keep-open button — it stays open until you close it (button / click
 * the icon again / Esc / click outside). VS Code-style peek, no layout shift.
 *
 * Hover/kept-open state is OWNED by the rail (single source of truth) so only one
 * flyout is ever open and hovering another node switches instantly. Uses
 * PopoverAnchor (not Trigger) so the icon's click is OURS (keep open), not
 * Radix's built-in open toggle.
 */
