/**
 * PhoneView — mobile Agents list + a live, driveable terminal stage.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Status } from '@flock/shared';
import { loudStatusWord } from '@flock/shared';
import { sortSessionsByAttention } from '../tree/ordering';
import { usePaddock } from '../../store/paddock';
import GhosttyMobileTerminal from '../terminal/GhosttyMobileTerminal';
import {
  Bot,
  Check,
  FolderPlus,
  GitBranch,
  HardDrive,
  Keyboard,
  Menu,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { FlockMark } from '../../components/SheepIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui';
import { useVisualViewportWidth } from './useVisualViewport';

const ATTENTION_STATUSES: ReadonlySet<Status> = new Set<Status>(['awaiting_input', 'error']);

function needsAttention(status: Status): boolean {
  return ATTENTION_STATUSES.has(status);
}

export interface PhoneSession {
  readonly id: string;
  readonly label: string;
  readonly status: Status;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly nodeId?: string;
  readonly nodeName?: string;
}

export interface PhoneNode {
  readonly id: string;
  readonly name: string;
}

export interface PhoneProject {
  readonly id: string;
  readonly nodeId: string;
  readonly name: string;
}

export interface PhoneViewProps {
  readonly sessions: readonly PhoneSession[];
  readonly nodes?: readonly PhoneNode[];
  readonly projects?: readonly PhoneProject[];
  readonly onSelectSession?: (sessionId: string) => void;
  /**
   * Optional input override for tests. Production writes through the live terminal.
   */
  readonly onSendInput?: (sessionId: string, text: string, submit: boolean) => void | Promise<void>;
}

const STATUS_LABEL: Record<Status, string> = {
  starting: 'Starting',
  running: 'Running',
  awaiting_input: 'Needs you',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  disconnected: 'Disconnected',
};

function statusDotVar(status: Status): string {
  const key = status === 'awaiting_input' ? 'awaiting' : status;
  return `var(--flock-status-${key})`;
}

function SessionRow({
  session,
  onSelectSession,
}: {
  session: PhoneSession;
  onSelectSession?: (id: string) => void;
}): JSX.Element {
  const rings = needsAttention(session.status);
  const loud = loudStatusWord(session.status);

  return (
    <li
      data-testid="phone-session"
      data-session-id={session.id}
      data-status={session.status}
      className="flex flex-col gap-2 border-b border-flock-muted/15 px-4 py-3"
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        onClick={() => onSelectSession?.(session.id)}
      >
        <span
          className={`size-2.5 shrink-0 rounded-full ${rings ? 'animate-pulse' : ''}`}
          style={{ background: statusDotVar(session.status) }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-flock-ink-primary">{session.label}</div>
          <div className="text-2xs text-flock-ink-muted">
            {loud ?? STATUS_LABEL[session.status]}
          </div>
        </div>
      </button>
    </li>
  );
}

const KEY_STRIP: ReadonlyArray<{ label: string; seq: string }> = [
  { label: 'Esc', seq: '\u001b' },
  { label: 'Tab', seq: '\t' },
  { label: '⇧Tab', seq: '\u001b[Z' },
  { label: '↑', seq: '\u001b[A' },
  { label: '↓', seq: '\u001b[B' },
  { label: 'Enter', seq: '\r' },
  { label: 'Ctrl-C', seq: '\u0003' },
];

function PhoneStage({
  session,
  sessions,
  nodes,
  onBack,
  onSelectNode,
  onNewAgent,
  onNodeDetails,
  onProjectGit,
  onSettings,
  onTerminate,
  onSelectSession,
  onSendInput,
}: {
  session: PhoneSession;
  sessions: readonly PhoneSession[];
  nodes: readonly PhoneNode[];
  onBack: () => void;
  onSelectNode: (nodeId: string) => void;
  onNewAgent: () => void;
  onNodeDetails: () => void;
  onProjectGit: () => void;
  onSettings: () => void;
  onTerminate: () => void;
  onSelectSession: (sessionId: string) => void;
  onSendInput?: (sessionId: string, text: string, submit: boolean) => void | Promise<void>;
}): JSX.Element {
  const viewportWidth = useVisualViewportWidth();
  const terminalInputRef = useRef<((text: string) => void) | null>(null);
  const terminalFocusRef = useRef<(() => void) | null>(null);
  const registerTerminalInput = useCallback((sendInput: ((text: string) => void) | null) => {
    terminalInputRef.current = sendInput;
  }, []);
  const registerTerminalFocus = useCallback((focus: (() => void) | null) => {
    terminalFocusRef.current = focus;
  }, []);

  const send = (text: string): void => {
    if (onSendInput) void onSendInput(session.id, text, false);
    else terminalInputRef.current?.(text);
  };

  return (
    <div
      className="flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-flock-bg"
      data-testid="phone-stage"
      style={{ width: viewportWidth == null ? '100%' : `${viewportWidth}px` }}
    >
      <header className="flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open mobile navigation"
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
            >
              <Menu className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[70dvh] w-64 overflow-y-auto">
            <DropdownMenuLabel>Switch agent</DropdownMenuLabel>
            <DropdownMenuItem onSelect={onBack}>All agents</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewAgent}>
              <Plus /> Start new agent
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNodeDetails}>
              <HardDrive /> Node details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onProjectGit}>
              <GitBranch /> Project Git
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSettings}>
              <Settings /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem className="text-status-error" onSelect={onTerminate}>
              <Trash2 /> Terminate agent
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Nodes</DropdownMenuLabel>
            {nodes.map((node) => (
              <DropdownMenuItem key={node.id} onSelect={() => onSelectNode(node.id)}>
                <HardDrive /> {node.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {sessions.map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => onSelectSession(item.id)}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: statusDotVar(item.status) }}
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.id === session.id ? <Check className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div
          className="flex shrink-0 items-center gap-1.5 border-r border-[var(--flock-border)] pr-2"
          data-testid="phone-brand"
        >
          <FlockMark className="size-5" />
          <span className="font-wordmark text-sm font-semibold text-flock-ink-primary">Flock</span>
        </div>
        <div className="min-w-0 flex-1 truncate text-xs font-medium">{session.label}</div>
        <span
          role="img"
          className="size-2 shrink-0 rounded-full"
          style={{ background: statusDotVar(session.status) }}
          title={STATUS_LABEL[session.status]}
          aria-label={STATUS_LABEL[session.status]}
        />
      </header>
      <div className="min-h-0 flex-1 bg-[#090909]" data-testid="phone-live-terminal">
        <GhosttyMobileTerminal
          sessionId={session.id}
          registerInput={registerTerminalInput}
          registerFocus={registerTerminalFocus}
        />
      </div>
      <div
        className="flex min-w-0 shrink-0 flex-nowrap gap-1 overflow-x-auto border-t border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1.5"
        data-testid="phone-key-strip"
        aria-label="Terminal keys"
      >
        {KEY_STRIP.map((k) => (
          <button
            key={k.label}
            type="button"
            className="shrink-0 rounded border border-[var(--flock-border)] bg-flock-surface-0 px-2 py-1 text-2xs"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => send(k.seq)}
          >
            {k.label}
          </button>
        ))}
        <button
          type="button"
          aria-label="Open terminal keyboard"
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded border border-[var(--flock-border)] bg-flock-surface-0"
          onPointerDown={(event) => {
            if (event.pointerType === 'touch' || event.pointerType === 'pen') {
              event.preventDefault();
              terminalFocusRef.current?.();
            }
          }}
          onClick={() => terminalFocusRef.current?.()}
        >
          <Keyboard className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function PhoneView({
  sessions,
  nodes = [],
  projects = [],
  onSelectSession,
  onSendInput,
}: PhoneViewProps): JSX.Element {
  const viewportWidth = useVisualViewportWidth();
  const openAgent = usePaddock((s) => s.openAgent);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectSession = usePaddock((s) => s.selectSession);
  const openDialog = usePaddock((s) => s.openDialog);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const openProjectGit = usePaddock((s) => s.openProjectGit);
  const openSettings = usePaddock((s) => s.openSettings);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const ordered = useMemo(
    () =>
      sortSessionsByAttention(sessions.map((s) => ({ id: s.id, status: s.status })))
        .map((o) => sessions.find((s) => s.id === o.id)!)
        .filter(Boolean),
    [sessions],
  );

  const selected = selectedSessionId
    ? (sessions.find((s) => s.id === selectedSessionId) ?? null)
    : null;
  const selectFromMenu = (id: string): void => {
    const next = sessions.find((session) => session.id === id);
    openAgent(id, next?.projectId);
    onSelectSession?.(id);
  };

  const grouped = useMemo(() => {
    const tree = new Map<string, Map<string, PhoneSession[]>>();
    for (const node of nodes) tree.set(node.name, new Map());
    for (const candidate of projects) {
      const nodeName = nodes.find((node) => node.id === candidate.nodeId)?.name ?? 'Unknown node';
      const nodeProjects = tree.get(nodeName) ?? new Map<string, PhoneSession[]>();
      if (!nodeProjects.has(candidate.name)) nodeProjects.set(candidate.name, []);
      tree.set(nodeName, nodeProjects);
    }
    for (const session of ordered) {
      const node = session.nodeName ?? 'Unknown node';
      const project = session.projectName ?? 'Unknown project';
      const nodeProjects = tree.get(node) ?? new Map<string, PhoneSession[]>();
      const items = nodeProjects.get(project) ?? [];
      items.push(session);
      nodeProjects.set(project, items);
      tree.set(node, nodeProjects);
    }
    return [...tree.entries()]
      .map(([nodeName, nodeProjects]) => {
        const nodeId =
          nodes.find((node) => node.name === nodeName)?.id ??
          [...nodeProjects.values()][0]?.[0]?.nodeId;
        return {
          nodeId,
          nodeName,
          projects: [...nodeProjects.entries()].map(([projectName, items]) => ({
            projectId:
              projects.find(
                (candidate) => candidate.nodeId === nodeId && candidate.name === projectName,
              )?.id ?? items[0]?.projectId,
            projectName,
            items,
          })),
        };
      })
      .filter((node) => selectedNodeId == null || node.nodeId === selectedNodeId);
  }, [nodes, ordered, projects, selectedNodeId]);

  if (selected) {
    return (
      <PhoneStage
        session={selected}
        sessions={ordered}
        nodes={nodes}
        onBack={() => selectSession(null)}
        onSelectNode={(nodeId) => {
          setSelectedNodeId(nodeId);
          selectSession(null);
        }}
        onNewAgent={() => openDialog('session')}
        onNodeDetails={() => selected.nodeId && openNodeInfo(selected.nodeId)}
        onProjectGit={() => selected.projectId && openProjectGit(selected.projectId)}
        onSettings={() => openSettings()}
        onTerminate={() => openDialog('terminate-session', { sessionId: selected.id })}
        onSelectSession={selectFromMenu}
        onSendInput={onSendInput}
      />
    );
  }

  return (
    <div
      className="flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-flock-bg"
      data-testid="phone-view"
      style={{ width: viewportWidth == null ? '100%' : `${viewportWidth}px` }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open mobile navigation"
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
            >
              <Menu className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[70dvh] w-64 overflow-y-auto">
            <DropdownMenuLabel>Navigate</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setSelectedNodeId(null)}>
              All nodes
              {selectedNodeId == null ? <Check className="ml-auto size-3.5" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog('session')}>
              <Plus /> Start new agent
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog('node')}>
              <HardDrive /> Add node
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                openDialog('project', selectedNodeId ? { nodeId: selectedNodeId } : undefined)
              }
            >
              <FolderPlus /> Add project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openSettings()}>
              <Settings /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Nodes</DropdownMenuLabel>
            {nodes.map((node) => (
              <DropdownMenuItem key={node.id} onSelect={() => setSelectedNodeId(node.id)}>
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {selectedNodeId === node.id ? <Check className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Agents</DropdownMenuLabel>
            {ordered.map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => selectFromMenu(item.id)}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: statusDotVar(item.status) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  <span className="block truncate text-3xs text-flock-ink-muted">
                    {item.nodeName ?? 'Unknown node'} · {item.projectName ?? 'Unknown project'}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <FlockMark className="size-6" />
        <div className="min-w-0">
          <h1 className="font-wordmark text-base font-semibold text-flock-ink-primary">Flock</h1>
          <p className="text-2xs text-flock-ink-muted">
            {selectedNodeId
              ? `${nodes.find((node) => node.id === selectedNodeId)?.name ?? 'Node'} · agents`
              : 'All nodes · agents'}
          </p>
        </div>
      </header>
      {grouped.length === 0 && selectedNodeId == null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-flock-ink-muted">
          No nodes yet. Use the menu to add your first node.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="phone-hierarchy">
          {grouped.length === 0 && selectedNodeId ? (
            <section data-testid="phone-node-group">
              <h2 className="border-b border-[var(--flock-border)] bg-flock-surface-1 px-3 py-2 text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
                {nodes.find((node) => node.id === selectedNodeId)?.name ?? 'Node'}
              </h2>
              {projects.filter((project) => project.nodeId === selectedNodeId).length === 0 ? (
                <div className="space-y-2 p-4 text-xs text-flock-ink-muted">
                  <p>No projects on this node.</p>
                  <button
                    type="button"
                    className="rounded-md bg-flock-accent px-3 py-2 font-medium text-white"
                    onClick={() => openDialog('project', { nodeId: selectedNodeId })}
                  >
                    Add project
                  </button>
                </div>
              ) : (
                projects
                  .filter((project) => project.nodeId === selectedNodeId)
                  .map((project) => (
                    <div
                      key={project.id}
                      className="flex items-center border-b border-flock-muted/10 px-4 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
                      <button
                        type="button"
                        className="rounded-md bg-flock-accent px-3 py-2 text-xs font-medium text-white"
                        onClick={() => openDialog('session', { projectId: project.id })}
                      >
                        Start agent
                      </button>
                    </div>
                  ))
              )}
            </section>
          ) : null}
          {grouped.map((node) => (
            <section key={node.nodeName} data-testid="phone-node-group">
              <div className="sticky top-0 z-10 flex items-center border-b border-[var(--flock-border)] bg-flock-surface-1 pl-3 pr-2">
                <h2 className="min-w-0 flex-1 truncate py-2 text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
                  {node.nodeName}
                </h2>
                <button
                  type="button"
                  aria-label={`View ${node.nodeName} details`}
                  className="flex size-8 items-center justify-center text-flock-ink-muted"
                  onClick={() => node.nodeId && openNodeInfo(node.nodeId)}
                >
                  <HardDrive className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label={`Add project to ${node.nodeName}`}
                  className="flex size-8 items-center justify-center text-flock-accent"
                  onClick={() =>
                    openDialog('project', node.nodeId ? { nodeId: node.nodeId } : undefined)
                  }
                >
                  <FolderPlus className="size-4" />
                </button>
              </div>
              {node.projects.length === 0 ? (
                <p className="px-4 py-3 text-xs text-flock-ink-muted">No projects</p>
              ) : (
                node.projects.map((project) => (
                  <div key={project.projectName} data-testid="phone-project-group">
                    <div className="flex items-center border-b border-flock-muted/10 bg-flock-surface-0 pl-4 pr-2">
                      <h3 className="min-w-0 flex-1 truncate py-1.5 text-xs font-medium text-flock-ink-primary">
                        {project.projectName}
                        <span className="ml-1.5 text-2xs font-normal text-flock-ink-muted">
                          {project.items.length} {project.items.length === 1 ? 'agent' : 'agents'}
                        </span>
                      </h3>
                      <button
                        type="button"
                        aria-label={`Open Git for ${project.projectName}`}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-flock-ink-muted"
                        onClick={() => project.projectId && openProjectGit(project.projectId)}
                      >
                        <GitBranch className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Start agent in ${project.projectName}`}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-flock-accent"
                        onClick={() => {
                          const projectId = project.projectId;
                          openDialog('session', projectId ? { projectId } : undefined);
                        }}
                      >
                        <Bot className="size-4" />
                      </button>
                    </div>
                    <ul>
                      {project.items.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          onSelectSession={selectFromMenu}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
