/**
 * Agents lens switcher — pin-first list with sort/filter (herdr Agents view).
 */
import { useMemo, useState } from 'react';
import {
  orderAgents,
  groupAgents,
  displayStatus,
  sessionInHostScope,
  type AgentSortKey,
  type AgentGroupKey,
  type AgentListItem,
  type Status,
} from '@flock/shared';
import {
  Columns2,
  GripVertical,
  LayoutGrid,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Pin,
  RotateCcw,
  Rows2,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { usePaddock } from '../../store/paddock';
import { useNodes, useProjects, useSessions, useUpdateSession } from '../../data/queries';
import { useLiveStatuses, useLiveStatusTransitions } from '../paddock/liveData';
import { StatusDot } from '../../components/StatusDot';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '../../components/ui';

const SORT_LABELS: Record<AgentSortKey, string> = {
  attention: 'Needs attention',
  status: 'Status',
  lastStatusChange: 'Recent activity',
  project: 'Project',
  node: 'Node',
};

const GROUP_LABELS: Record<AgentGroupKey, string> = {
  none: 'No grouping',
  node: 'Node',
  project: 'Project',
  nodeProject: 'Node + project',
};

export function AgentsSwitcher(): JSX.Element {
  const { data: sessions = [] } = useSessions();
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const hostScope = usePaddock((s) => s.hostScope);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const openAgent = usePaddock((s) => s.openAgent);
  const openDialog = usePaddock((s) => s.openDialog);
  const penProjectId = usePaddock((s) => s.penProjectId);
  const penGroups = usePaddock((s) => s.penGroups);
  const activePenId = usePaddock((s) => s.activePenId);
  const requestPenAction = usePaddock((s) => s.requestPenAction);
  const statuses = useLiveStatuses();
  const transitions = useLiveStatusTransitions();
  const updateSession = useUpdateSession();
  const contextProjectId =
    selectedProjectId ??
    (selectedSessionId
      ? sessions.find((session) => session.id === selectedSessionId)?.projectId
      : null);
  const contextProject = projects.find((project) => project.id === contextProjectId);
  const contextNode = nodes.find((node) => node.id === nodeInfoNodeId);

  const [sort, setSort] = useState<AgentSortKey>('attention');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [workingOnly, setWorkingOnly] = useState(false);
  const [group, setGroup] = useState<AgentGroupKey>('none');
  const [renameSession, setRenameSession] = useState<{ id: string; value: string } | null>(null);
  const [renamePen, setRenamePen] = useState<{ id: string; value: string } | null>(null);
  const [dragOverZone, setDragOverZone] = useState<string | null>(null);

  const items = useMemo(() => {
    const open = sessions.filter((s) => s.closedAt === null);
    const scoped = open.filter((session) => {
      if (contextProjectId) return session.projectId === contextProjectId;
      if (nodeInfoNodeId) return session.nodeId === nodeInfoNodeId;
      return sessionInHostScope(hostScope, session, nodes);
    });
    const list: AgentListItem[] = scoped.map((s) => {
      const st = (statuses.get(s.id) ?? s.status) as Status;
      const node = nodes.find((n) => n.id === s.nodeId);
      const project = projects.find((p) => p.id === s.projectId);
      const lastMs = transitions.get(s.id) ?? (Date.parse(s.lastStatusAt) || 0);
      return {
        id: s.id,
        nodeId: s.nodeId,
        projectId: s.projectId,
        nodeName: node?.name,
        projectName: project?.name,
        pinned: s.pinned,
        status: st,
        lastStatusTransitionAt: lastMs,
        label: s.note?.trim() || `${s.agentType} · ${s.id.slice(0, 6)}`,
      };
    });
    return orderAgents(list, { sort, pinnedOnly, workingOnly });
  }, [
    sessions,
    nodes,
    projects,
    hostScope,
    contextProjectId,
    nodeInfoNodeId,
    statuses,
    transitions,
    sort,
    pinnedOnly,
    workingOnly,
  ]);

  const groups = useMemo(() => groupAgents(items, group), [items, group]);
  const penMode = contextProjectId != null && penProjectId === contextProjectId;
  const displayGroups = useMemo(() => {
    if (!penMode) return groups.map((entry) => ({ ...entry, zone: null, arrange: null }));
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
  }, [groups, items, penGroups, penMode]);
  const activeFilterCount = Number(pinnedOnly) + Number(workingOnly);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-switcher">
      <div className="border-b border-[var(--flock-border)] p-2" data-testid="agent-list-controls">
        {contextProject || contextNode ? (
          <div
            className="mb-2 flex min-w-0 items-center gap-1 px-1 text-2xs text-flock-ink-muted"
            data-testid="agent-list-context"
          >
            <span>{contextProject ? 'Project' : 'Node'}:</span>
            <span className="truncate font-semibold text-flock-ink-primary">
              {contextProject?.name ?? contextNode?.name}
            </span>
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant={activeFilterCount > 0 ? 'secondary' : 'outline'}
              aria-label="Agent list view options"
              className="w-full justify-start px-2"
            >
              <SlidersHorizontal />
              <span className="font-semibold">View</span>
              <span className="ml-auto min-w-0 truncate text-2xs font-normal text-flock-ink-muted">
                {SORT_LABELS[sort]}
                {group !== 'none' ? ` · ${GROUP_LABELS[group]}` : ''}
              </span>
              {activeFilterCount > 0 ? (
                <span className="rounded-full bg-flock-accent px-1.5 text-2xs text-white">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => setSort(value as AgentSortKey)}
            >
              {Object.entries(SORT_LABELS).map(([value, label]) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Group by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={group}
              onValueChange={(value) => setGroup(value as AgentGroupKey)}
            >
              {Object.entries(GROUP_LABELS).map(([value, label]) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Show only</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={pinnedOnly}
              onCheckedChange={(checked) => setPinnedOnly(checked === true)}
            >
              Pinned sessions
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={workingOnly}
              onCheckedChange={(checked) => setWorkingOnly(checked === true)}
            >
              Currently working
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
            {penMode || group !== 'none' ? (
              <div
                className={`group/pen flex min-h-8 items-center gap-1 px-2 py-1 text-[13px] font-semibold uppercase tracking-wide ${g.zone === activePenId ? 'bg-flock-accent/10 text-flock-accent' : 'text-flock-ink-muted'}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  disabled={!g.zone || g.zone === 'other' || g.zone === 'new'}
                  onClick={() => g.zone && requestPenAction({ type: 'select', penId: g.zone })}
                >
                  {g.label}
                </button>
                {g.arrange ? (
                  <span
                    className={`flex items-center gap-0.5 rounded-md border border-[var(--flock-border)] bg-flock-surface-0 p-0.5 transition-opacity ${g.zone === activePenId ? 'opacity-100' : 'opacity-60 group-hover/pen:opacity-100'}`}
                    aria-label={`${g.label} layout`}
                  >
                    <button
                      type="button"
                      aria-label="Side by side"
                      title="Columns"
                      onClick={() =>
                        requestPenAction({ type: 'arrange', penId: g.zone!, mode: 'row' })
                      }
                      className={`flex size-6 items-center justify-center rounded ${g.arrange === 'row' ? 'bg-flock-accent/15 text-flock-accent' : 'hover:bg-flock-surface-2 hover:text-flock-ink-primary'}`}
                    >
                      <Columns2 className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Stacked"
                      title="Rows"
                      onClick={() =>
                        requestPenAction({ type: 'arrange', penId: g.zone!, mode: 'col' })
                      }
                      className={`flex size-6 items-center justify-center rounded ${g.arrange === 'col' ? 'bg-flock-accent/15 text-flock-accent' : 'hover:bg-flock-surface-2 hover:text-flock-ink-primary'}`}
                    >
                      <Rows2 className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Grid"
                      title="2×2 grid"
                      onClick={() =>
                        requestPenAction({
                          type: 'arrange',
                          penId: g.zone!,
                          mode: 'grid2x2',
                        })
                      }
                      className={`flex size-6 items-center justify-center rounded ${g.arrange === 'grid2x2' ? 'bg-flock-accent/15 text-flock-accent' : 'hover:bg-flock-surface-2 hover:text-flock-ink-primary'}`}
                    >
                      <LayoutGrid className="size-3.5" />
                    </button>
                  </span>
                ) : null}
                {g.arrange && g.zone ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded hover:bg-flock-surface-2"
                        aria-label={`${g.label} actions`}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44 normal-case tracking-normal">
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
                      <DropdownMenuItem
                        onSelect={() =>
                          requestPenAction({
                            type: 'arrange',
                            penId: g.zone!,
                            mode: 'grid2x2',
                          })
                        }
                      >
                        <RotateCcw /> Reset layout
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
                        ? 'font-semibold text-flock-accent'
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
                      title="Drag to move between Pens; click to focus"
                      className={`flex min-w-0 flex-1 cursor-grab items-start gap-1.5 py-2 pl-1.5 text-left text-[15px] active:cursor-grabbing ${
                        active ? 'bg-flock-accent/10' : ''
                      }`}
                    >
                      <GripVertical className="size-3.5 shrink-0 self-center text-flock-ink-muted/45 transition-colors group-hover:text-flock-ink-muted" />
                      <StatusDot status={item.status} className="self-center" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-flock-ink-primary">
                            {item.label}
                          </span>
                          {item.pinned ? (
                            <Pin className="size-3 shrink-0 text-flock-accent" />
                          ) : null}
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
                          <MoreHorizontal className="size-4" />
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
                        <DropdownMenuItem
                          onSelect={() =>
                            updateSession.mutate({
                              id: item.id,
                              patch: { pinned: !item.pinned },
                            })
                          }
                        >
                          <Pin className={item.pinned ? 'text-flock-accent' : undefined} />
                          {item.pinned ? 'Remove from top' : 'Keep at top'}
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
