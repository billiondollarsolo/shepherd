/** Paddock fleet home: one operational Node → Project → Agent hierarchy. */
import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Bot, FileCode2, FolderGit2, GitBranch, HardDrive } from 'lucide-react';
import {
  displayStatus,
  nodeInHostScope,
  type GitStatusResponse,
  type Session,
  type Status,
} from '@flock/shared';
import { StatusDot } from '../../components/StatusDot';
import { useFleetGit, useNodes, useProjects, useSessions } from '../../data/queries';
import { usePaddock } from '../../store/paddock';
import { useLiveStatuses } from '../paddock/liveData';

const CONNECTION_COLOR: Record<string, string> = {
  connected: 'bg-status-idle',
  connecting: 'bg-status-awaiting',
  disconnected: 'bg-status-disconnected',
  error: 'bg-status-error',
};

function sessionLabel(session: Session): string {
  return session.note?.trim() || `${session.agentType} · ${session.id.slice(0, 6)}`;
}

function ProjectGitSummary({ git }: { git: GitStatusResponse | undefined }): JSX.Element {
  if (!git) return <span className="text-flock-ink-muted">Git status unavailable</span>;
  return (
    <span className="flex flex-wrap items-center gap-2 font-mono text-2xs">
      <span className="inline-flex items-center gap-1 text-flock-ink-primary">
        <GitBranch className="size-3" /> {git.branch ?? 'detached'}
      </span>
      {git.files.length > 0 ? (
        <span className="inline-flex items-center gap-1 text-status-awaiting">
          <FileCode2 className="size-3" /> {git.files.length} changed
        </span>
      ) : (
        <span className="text-flock-ink-muted">Clean</span>
      )}
      {git.ahead > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-flock-ink-muted">
          <ArrowUp className="size-3" /> {git.ahead}
        </span>
      ) : null}
      {git.behind > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-flock-ink-muted">
          <ArrowDown className="size-3" /> {git.behind}
        </span>
      ) : null}
    </span>
  );
}

export function FleetView(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useSessions();
  const live = useLiveStatuses();
  const hostScope = usePaddock((s) => s.hostScope);
  const openAgent = usePaddock((s) => s.openAgent);
  const selectProject = usePaddock((s) => s.selectProject);
  const openRight = usePaddock((s) => s.openRight);

  const visibleNodes = useMemo(
    () => nodes.filter((node) => nodeInHostScope(hostScope, node)),
    [hostScope, nodes],
  );
  const openSessions = useMemo(
    () => sessions.filter((session) => session.closedAt === null),
    [sessions],
  );
  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes],
  );
  const visibleSessions = useMemo(
    () => openSessions.filter((session) => visibleNodeIds.has(session.nodeId)),
    [openSessions, visibleNodeIds],
  );
  const gitBySession = useFleetGit(visibleSessions.map((session) => session.id));
  const statusOf = (session: Session): Status => live.get(session.id) ?? session.status;

  const openProjectGit = (session: Session): void => {
    openAgent(session.id, session.projectId);
    openRight('diff');
  };

  return (
    <div className="h-full overflow-y-auto bg-flock-surface-0" data-testid="fleet-hierarchy">
      <header className="border-b border-[var(--flock-border)] px-6 py-4">
        <h1 className="font-display text-xl font-semibold text-flock-ink-primary">Paddock</h1>
        <p className="mt-0.5 text-sm text-flock-ink-muted">
          Nodes, projects, agents, and their current state.
        </p>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4 sm:p-6">
        {visibleNodes.map((node) => {
          const nodeProjects = projects.filter((project) => project.nodeId === node.id);
          const nodeSessions = visibleSessions.filter((session) => session.nodeId === node.id);
          return (
            <details
              key={node.id}
              open
              className="overflow-hidden rounded-lg border border-[var(--flock-border)] bg-flock-surface-1"
            >
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-flock-surface-2">
                <span className="flex size-8 items-center justify-center rounded-md bg-flock-surface-2 text-flock-ink-muted">
                  <HardDrive className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-flock-ink-primary">
                      {node.name}
                    </span>
                    <span
                      className={`size-2 rounded-full ${CONNECTION_COLOR[node.connectionStatus] ?? 'bg-status-disconnected'}`}
                    />
                  </span>
                  <span className="text-2xs capitalize text-flock-ink-muted">
                    {node.connectionStatus} · {nodeProjects.length} projects · {nodeSessions.length}{' '}
                    agents
                  </span>
                </span>
              </summary>

              <div className="border-t border-[var(--flock-border)] p-2">
                {nodeProjects.map((project) => {
                  const projectSessions = nodeSessions.filter(
                    (session) => session.projectId === project.id,
                  );
                  const gitSession = projectSessions.find((session) =>
                    gitBySession.has(session.id),
                  );
                  const projectGit = gitSession ? gitBySession.get(gitSession.id) : undefined;
                  return (
                    <div
                      key={project.id}
                      className="mb-2 overflow-hidden rounded-md border border-[var(--flock-border)] bg-flock-surface-0 last:mb-0"
                    >
                      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                        <FolderGit2 className="size-4 shrink-0 text-flock-ink-muted" />
                        <button
                          type="button"
                          onClick={() => selectProject(project.id)}
                          className="min-w-0 text-left"
                        >
                          <span className="block truncate text-sm font-semibold text-flock-ink-primary hover:text-flock-accent">
                            {project.name}
                          </span>
                          <span className="block truncate font-mono text-2xs text-flock-ink-muted">
                            {project.workingDir}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={!gitSession}
                          onClick={() => gitSession && openProjectGit(gitSession)}
                          className="ml-auto rounded-md px-2 py-1 text-left hover:bg-flock-surface-2 disabled:cursor-default"
                          aria-label={`Open ${project.name} source control`}
                        >
                          <ProjectGitSummary git={projectGit} />
                        </button>
                      </div>

                      <div className="border-t border-[var(--flock-border)]">
                        {projectSessions.map((session) => {
                          const status = statusOf(session);
                          const display = displayStatus(status);
                          return (
                            <button
                              key={session.id}
                              type="button"
                              onClick={() => openAgent(session.id, project.id)}
                              className="flex w-full items-center gap-2 border-b border-[var(--flock-border)] px-3 py-2 text-left last:border-b-0 hover:bg-flock-surface-2"
                            >
                              <Bot className="size-3.5 shrink-0 text-flock-ink-muted" />
                              <StatusDot status={status} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-flock-ink-primary">
                                  {sessionLabel(session)}
                                </span>
                              </span>
                              <span className="shrink-0 text-xs font-medium text-flock-ink-muted">
                                {display.label}
                              </span>
                            </button>
                          );
                        })}
                        {projectSessions.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-flock-ink-muted">
                            No running agents.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {nodeProjects.length === 0 ? (
                  <div className="px-2 py-4 text-center text-sm text-flock-ink-muted">
                    No projects on this node.
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}

        {visibleNodes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--flock-border)] p-10 text-center text-sm text-flock-ink-muted">
            No nodes in this fleet scope.
          </div>
        ) : null}
      </div>
    </div>
  );
}
