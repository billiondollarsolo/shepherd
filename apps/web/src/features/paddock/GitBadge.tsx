/**
 * GitBadge — a compact "⎇ branch · N" chip flagging an agent with uncommitted
 * work, for at-a-glance fleet scanning (project summaries and
 * cards). Pure: the caller supplies the git status (from useFleetGit / useGitStatus,
 * which share one cache), so this never fetches. Renders null when there's nothing
 * to flag, so clean working trees add no noise.
 */
import { GitBranch } from 'lucide-react';
import type { GitStatusResponse } from '@flock/shared';

/** Number of changed files (staged or unstaged) in a git status. */
export function changedCount(git: GitStatusResponse | null | undefined): number {
  return git?.files.length ?? 0;
}

export function GitBadge({
  git,
  className,
}: {
  git: GitStatusResponse | null | undefined;
  className?: string;
}): JSX.Element | null {
  const n = changedCount(git);
  if (!git || n === 0) return null;
  return (
    <span
      className={`flex items-center gap-1 rounded-full bg-flock-surface-2 px-1.5 py-0.5 text-2xs text-flock-ink-muted ${className ?? ''}`}
      title={`${git.branch ?? 'detached'} — ${n} uncommitted change${n === 1 ? '' : 's'}`}
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="font-medium tabular-nums text-flock-ink-primary">{n}</span>
    </span>
  );
}
