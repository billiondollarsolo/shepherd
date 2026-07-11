import { ArrowLeft, GitBranch } from 'lucide-react';
import { Button } from '../../components/ui';
import { useProjects, useSessions } from '../../data/queries';
import { usePaddock } from '../../store/paddock';
import SourceControlPanel from '../center/SourceControlPanel';

/** Dedicated project-level Git workspace. A session supplies API authorization
 * context, but opening this page never focuses or zooms that agent. */
export function ProjectGitPage(): JSX.Element {
  const projectId = usePaddock((s) => s.selectedProjectId);
  const selectProject = usePaddock((s) => s.selectProject);
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useSessions();
  const project = projects.find((candidate) => candidate.id === projectId);
  const session = sessions.find(
    (candidate) => candidate.closedAt === null && candidate.projectId === projectId,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-surface-0" data-testid="project-git-page">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--flock-border)] bg-flock-surface-1 px-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => selectProject(projectId)}
          aria-label="Back to project agents"
        >
          <ArrowLeft className="size-4" /> Agents
        </Button>
        <div className="h-5 w-px bg-[var(--flock-border)]" />
        <GitBranch className="size-4 text-flock-accent" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-flock-ink-primary">
            {project?.name ?? 'Project'} Source Control
          </div>
          <div className="truncate font-mono text-2xs text-flock-ink-muted">
            {project?.workingDir}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {session ? (
          <SourceControlPanel sessionId={session.id} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-flock-ink-muted">
            Start an agent in this project to inspect its Git state.
          </div>
        )}
      </div>
    </div>
  );
}
