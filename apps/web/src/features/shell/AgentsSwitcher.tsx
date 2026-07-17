/** Agents sidebar — Pens own membership and drag order. */
import { useMemo, useState } from 'react';
import { displayStatus, type Status } from '@flock/shared';
import {
  Check,
  Columns2,
  GripVertical,
  GitBranch,
  LayoutGrid,
  MoreVertical,
  RadioTower,
  MoveRight,
  Pencil,
  Plus,
  Rows2,
  Trash2,
} from 'lucide-react';
import { usePaddock } from '../../store/paddock';
import { useNodes, useProjects, useSessions, useUpdateSession } from '../../data/queries';
import { useLiveStatuses } from '../paddock/liveData';
import { StatusDot } from '../../components/StatusDot';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '../../components/ui';

export function AgentsSwitcher(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const openAgent = usePaddock((s) => s.openAgent);
  const openDialog = usePaddock((s) => s.openDialog);
  const selectProject = usePaddock((s) => s.selectProject);
  const penProjectId = usePaddock((s) => s.penProjectId);
  const penGroups = usePaddock((s) => s.penGroups);
  const activePenId = usePaddock((s) => s.activePenId);
  const requestPenAction = usePaddock((s) => s.requestPenAction);
  const projectView = usePaddock((s) => s.projectView);
  const openProjectGit = usePaddock((s) => s.openProjectGit);
  const openProjectPorts = usePaddock((s) => s.openProjectPorts);
  const statuses = useLiveStatuses();
  const updateSession = useUpdateSession();
  const contextProjectId =
    selectedProjectId ??
    (selectedSessionId
      ? sessions.find((session) => session.id === selectedSessionId)?.projectId
      : null);
  const contextProject = projects.find((project) => project.id === contextProjectId);
  const contextNode = nodes.find((node) => node.id === nodeInfoNodeId);
  const contextProjectNode = contextProject
    ? nodes.find((node) => node.id === contextProject.nodeId)
    : undefined;

  const [renameSession, setRenameSession] = useState<{ id: string; value: string } | null>(null);
  const [renamePen, setRenamePen] = useState<{ id: string; value: string } | null>(null);
  const [dragOverZone, setDragOverZone] = useState<string | null>(null);

  const items = useMemo(() => {
    const open = sessions.filter((s) => s.closedAt === null);
    const scoped = open.filter((session) => {
      if (contextProjectId) return session.projectId === contextProjectId;
      if (nodeInfoNodeId) return session.nodeId === nodeInfoNodeId;
      return true;
    });
    return scoped.map((s) => {
      const st = (statuses.get(s.id) ?? s.status) as Status;
      const node = nodes.find((n) => n.id === s.nodeId);
      const project = projects.find((p) => p.id === s.projectId);
      return {
        id: s.id,
        nodeId: s.nodeId,
        projectId: s.projectId,
        nodeName: node?.name,
        projectName: project?.name,
        status: st,
        label: s.note?.trim() || `${s.agentType} · ${s.id.slice(0, 6)}`,
      };
    });
  }, [sessions, nodes, projects, contextProjectId, nodeInfoNodeId, statuses]);

  const penMode = contextProjectId != null && penProjectId === contextProjectId;
  const displayGroups = useMemo(() => {
    if (!penMode) return [{ key: 'agents', label: 'Agents', items, zone: null, arrange: null }];
    const byItemId = new Map(items.map((item) => [item.id, item]));
    const penSet = new Set(penGroups.flatMap((pen) => pen.sessionIds));
    return [
      ...penGroups.map((pen) => ({
        key: pen.id,
        label: `${pen.name} · ${pen.sessionIds.length}/4`,
        items: pen.sessionIds.flatMap((id) => {
          const item = byItemId.get(id);
          return item ? [item] : [];
        }),
        zone: pen.id,
        arrange: pen.arrange,
      })),
      {
        key: 'other-agents',
        label: 'Other agents',
        items: items.filter((item) => !penSet.has(item.id)),
        zone: 'other' as const,
        arrange: null,
      },
      {
        key: 'new-pen',
        label: 'New Pen',
        items: [],
        zone: 'new' as const,
        arrange: null,
      },
    ];
  }, [items, penGroups, penMode]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-switcher">
      {contextProject || contextNode ? (
        <div className="border-b border-[var(--flock-border)] p-2" data-testid="agent-list-context">
          <div className="grid gap-0.5 px-1 pb-1.5 text-xs text-flock-ink-muted">
            {contextProject && contextProjectNode ? (
              <div className="flex min-w-0 items-center gap-1">
                <span className="font-semibold text-flock-ink-primary">Host:</span>
                <span
                  className="truncate text-flock-ink-muted"
                  title={contextProjectNode.host ?? contextProjectNode.name}
                >
                  {contextProjectNode.name}
                </span>
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-1">
              <span className="font-semibold text-flock-ink-primary">
                {contextProject ? 'Project' : 'Node'}:
              </span>
              <span className="truncate text-flock-ink-muted">
                {contextProject?.name ?? contextNode?.name}
              </span>
            </div>
          </div>
          {contextProject ? (
            <div className="grid gap-0.5">
              <button
                type="button"
                onClick={() => openDialog('session', { projectId: contextProject.id })}
                data-testid="agents-new-session"
                className="flex w-full items-center gap-2 rounded-md border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1.5 text-xs font-medium text-flock-ink-primary hover:bg-flock-surface-2"
              >
                <Plus className="size-3.5" /> New session
              </button>
              <button
                type="button"
                onClick={() => openProjectGit(contextProject.id)}
                data-active={projectView === 'git' ? '1' : '0'}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium ${
                  projectView === 'git'
                    ? 'bg-flock-accent/15 text-flock-ink-primary'
                    : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
                }`}
              >
                <GitBranch className="size-3.5" /> Source Control
              </button>
              <button
                type="button"
                onClick={() => openProjectPorts(contextProject.id)}
                data-active={projectView === 'ports' ? '1' : '0'}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium ${
                  projectView === 'ports'
                    ? 'bg-flock-accent/15 text-flock-ink-primary'
                    : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
                }`}
              >
                <RadioTower className="size-3.5" /> Ports
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {displayGroups.map((g) => (
          <div
            key={g.key}
            data-testid={g.zone ? `agent-zone-${g.zone}` : undefined}
            className={
              dragOverZone === g.zone
                ? 'bg-flock-accent/5 ring-1 ring-inset ring-flock-accent/50'
                : ''
            }
            onDragOver={(event) => {
              if (g.zone && event.dataTransfer.types.includes('application/x-flock-session')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverZone(g.zone);
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragOverZone(null);
              }
            }}
            onDrop={(event) => {
              if (!g.zone) return;
              const sessionId = event.dataTransfer.getData('application/x-flock-session');
              if (!sessionId) return;
              event.preventDefault();
              setDragOverZone(null);
              if (g.zone === 'new') requestPenAction({ type: 'create', sessionId });
              else if (g.zone === 'other') requestPenAction({ type: 'remove', sessionId });
              else requestPenAction({ type: 'add', sessionId, penId: g.zone });
            }}
          >
            {penMode ? (
              <div
                className={`group/pen flex min-h-8 items-center gap-1 px-2 py-1 text-xs font-semibold uppercase tracking-wide ${g.zone === activePenId ? 'text-flock-ink-primary' : 'text-flock-ink-muted'}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  disabled={!g.zone || g.zone === 'other' || g.zone === 'new'}
                  onClick={() => {
                    if (!g.zone) return;
                    if (contextProjectId) selectProject(contextProjectId);
                    requestPenAction({ type: 'select', penId: g.zone });
                  }}
                >
                  {g.label}
                </button>
                {g.arrange && g.zone ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded hover:bg-flock-surface-2"
                        aria-label={`${g.label} actions`}
                      >
                        <MoreVertical className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44 normal-case tracking-normal">
                      <DropdownMenuLabel>Layout</DropdownMenuLabel>
                      <DropdownMenuItem
                        onSelect={() =>
                          requestPenAction({ type: 'arrange', penId: g.zone!, mode: 'row' })
                        }
                      >
                        <Columns2 /> Side by side
                        {g.arrange === 'row' ? <Check className="ml-auto" /> : null}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          requestPenAction({ type: 'arrange', penId: g.zone!, mode: 'col' })
                        }
                      >
                        <Rows2 /> Stacked
                        {g.arrange === 'col' ? <Check className="ml-auto" /> : null}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          requestPenAction({
                            type: 'arrange',
                            penId: g.zone!,
                            mode: 'grid2x2',
                          })
                        }
                      >
                        <LayoutGrid /> Grid
                        {g.arrange === 'grid2x2' ? <Check className="ml-auto" /> : null}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          setRenamePen({
                            id: g.zone!,
                            value: penGroups.find((pen) => pen.id === g.zone)?.name ?? 'Pen',
                          })
                        }
                      >
                        <Pencil /> Rename Pen…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-status-error focus:text-status-error"
                        onSelect={() => requestPenAction({ type: 'delete', penId: g.zone! })}
                      >
                        <Trash2 /> Delete Pen
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            ) : null}
            {dragOverZone === g.zone && g.arrange && g.items.length >= 4 ? (
              <div className="px-2 py-1 text-center text-2xs font-medium text-flock-accent">
                Pen full — drop on an agent to replace it
              </div>
            ) : null}
            <ul className="flex flex-col">
              {g.items.map((item) => {
                // displayStatus was already exported; use .label (always set, incl. Idle).
                const disp = displayStatus(item.status);
                const active = item.id === selectedSessionId;
                const wordClass =
                  disp.kind === 'blocked'
                    ? 'font-semibold text-status-awaiting'
                    : disp.kind === 'error'
                      ? 'font-semibold text-status-error'
                      : disp.kind === 'working'
                        ? 'font-semibold text-flock-ink-primary'
                        : disp.kind === 'disconnected'
                          ? 'font-medium text-status-disconnected'
                          : 'font-medium text-flock-ink-muted'; // Idle — affirmative, calm
                return (
                  <li
                    key={item.id}
                    className="group flex hover:bg-flock-surface-2"
                    onDragOver={(event) => {
                      if (g.zone && g.zone !== 'other' && g.zone !== 'new') {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                      }
                    }}
                    onDrop={(event) => {
                      if (!g.zone || g.zone === 'other' || g.zone === 'new') return;
                      const sessionId = event.dataTransfer.getData('application/x-flock-session');
                      if (!sessionId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      requestPenAction({
                        type: 'move',
                        sessionId,
                        targetSessionId: item.id,
                        penId: g.zone,
                      });
                    }}
                  >
                    <button
                      type="button"
                      draggable
                      data-testid={`agent-row-${item.id}`}
                      data-active={active ? '1' : '0'}
                      onClick={() => openAgent(item.id, item.projectId)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-flock-session', item.id);
                      }}
                      onDragEnd={() => setDragOverZone(null)}
                      onKeyDown={(event) => {
                        if (!event.altKey || !g.zone || g.zone === 'other' || g.zone === 'new') {
                          return;
                        }
                        const offset =
                          event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                        if (offset === 0) return;
                        const orderedItems = g.items as typeof items;
                        const target = orderedItems[orderedItems.indexOf(item) + offset];
                        if (!target) return;
                        event.preventDefault();
                        requestPenAction({
                          type: 'move',
                          sessionId: item.id,
                          targetSessionId: target.id,
                          penId: g.zone,
                        });
                      }}
                      title="Drag to move between Pens; Alt+Up/Down reorders; click to focus"
                      aria-label={`${item.label}; Alt+Up or Alt+Down reorders within this Pen`}
                      className={`flex min-w-0 flex-1 cursor-grab items-start gap-1.5 py-2 pl-1.5 text-left text-sm active:cursor-grabbing ${
                        active ? 'bg-flock-accent/10' : ''
                      }`}
                    >
                      <GripVertical className="size-3.5 shrink-0 self-center text-flock-ink-muted opacity-0 transition-opacity group-hover:opacity-100" />
                      <StatusDot status={item.status} className="self-center" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-flock-ink-primary">
                            {item.label}
                          </span>
                          <span
                            className={`shrink-0 text-2xs ${wordClass}`}
                            data-testid={`agent-status-word-${item.id}`}
                          >
                            {disp.label}
                          </span>
                        </div>
                        <div className="truncate text-2xs text-flock-ink-muted">
                          {[item.nodeName, item.projectName].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Agent actions for ${item.label}`}
                          className="mr-2 shrink-0 self-center rounded p-1 text-flock-ink-muted opacity-0 hover:bg-flock-surface-1 hover:text-flock-ink-primary focus:opacity-100 group-hover:opacity-100"
                        >
                          <MoreVertical className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          onSelect={() =>
                            setRenameSession({
                              id: item.id,
                              value: sessions.find((session) => session.id === item.id)?.note ?? '',
                            })
                          }
                        >
                          <Pencil /> Rename session…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {penMode ? (
                          <>
                            <DropdownMenuLabel>Move to</DropdownMenuLabel>
                            {penGroups.map((pen) => {
                              const current = pen.sessionIds.includes(item.id);
                              return (
                                <DropdownMenuItem
                                  key={pen.id}
                                  disabled={current || pen.sessionIds.length >= 4}
                                  onSelect={() =>
                                    requestPenAction({
                                      type: 'add',
                                      sessionId: item.id,
                                      penId: pen.id,
                                    })
                                  }
                                >
                                  <MoveRight /> {pen.name}
                                  <span className="ml-auto text-2xs text-flock-ink-muted">
                                    {pen.sessionIds.length}/4
                                  </span>
                                </DropdownMenuItem>
                              );
                            })}
                            <DropdownMenuItem
                              onSelect={() =>
                                requestPenAction({ type: 'remove', sessionId: item.id })
                              }
                            >
                              <MoveRight /> Other agents
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                requestPenAction({ type: 'create', sessionId: item.id })
                              }
                            >
                              <MoveRight /> New Pen
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        ) : null}
                        <DropdownMenuItem
                          className="text-status-error focus:text-status-error"
                          onSelect={() => openDialog('terminate-session', { sessionId: item.id })}
                        >
                          <Trash2 />
                          Delete session…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
            {penMode && g.items.length === 0 ? (
              <div className="mx-2 mb-2 rounded border border-dashed border-[var(--flock-border)] px-2 py-3 text-center text-2xs text-flock-ink-muted">
                {g.zone === 'new'
                  ? 'Drop an agent here to create another Pen.'
                  : g.zone === 'other'
                    ? 'No other agents.'
                    : 'Drag an agent here.'}
              </div>
            ) : null}
          </div>
        ))}
        {items.length === 0 ? (
          <div className="p-4 text-center text-sm text-flock-ink-muted">No agents in scope.</div>
        ) : null}
      </div>
      <Dialog
        open={renameSession !== null}
        onOpenChange={(open) => !open && setRenameSession(null)}
      >
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!renameSession) return;
              updateSession.mutate({
                id: renameSession.id,
                patch: { note: renameSession.value.trim() || null },
              });
              setRenameSession(null);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              aria-label="Session name"
              placeholder="e.g. API migration"
              value={renameSession?.value ?? ''}
              onChange={(event) =>
                setRenameSession((current) =>
                  current ? { ...current, value: event.target.value } : current,
                )
              }
            />
            <DialogFooter>
              <Button type="submit">Save name</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={renamePen !== null} onOpenChange={(open) => !open && setRenamePen(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!renamePen?.value.trim()) return;
              requestPenAction({ type: 'rename', penId: renamePen.id, name: renamePen.value });
              setRenamePen(null);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename Pen</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              aria-label="Pen name"
              value={renamePen?.value ?? ''}
              onChange={(event) =>
                setRenamePen((current) =>
                  current ? { ...current, value: event.target.value } : current,
                )
              }
            />
            <DialogFooter>
              <Button type="submit" disabled={!renamePen?.value.trim()}>
                Save name
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
