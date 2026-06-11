/**
 * SourceControlPanel — the Source Control tab (US-33.1), the Codex "review loop"
 * beside the terminal. It replaces the read-only Diff tab's content with a real
 * git workflow:
 *
 *   - a branch header (name + ahead/behind the upstream);
 *   - the changed files split into STAGED and CHANGES groups, each row staging /
 *     unstaging on click and opening a per-file diff PREVIEW;
 *   - a commit message box + Commit (commits the staged set as the Flock user);
 *   - Push (runs with the node's own git credentials).
 *
 * Server data + mutations come from TanStack Query (`../../data/queries`); the
 * per-file preview fetches the scoped diff directly. The selected file lives in
 * the paddock store so the Activity "Files" artifact can deep-link into it.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, GitBranchPlus, GitPullRequest, Minus, Plus, RefreshCw } from 'lucide-react';
import type { GitFileStatus } from '@flock/shared';

import { usePaddock } from '../../store/paddock';
import {
  useCommit,
  useCreateBranch,
  useCreatePr,
  useGitStatus,
  usePush,
  useStageFiles,
  useUnstageFiles,
} from '../../data/queries';
import { fetchSessionDiff } from './diffApi';
import { isEmptyDiff, parseDiff, type DiffLineKind } from './diffLines';

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'text-diff-add',
  remove: 'text-diff-remove',
  hunk: 'text-flock-accent',
  meta: 'text-flock-muted',
  context: 'text-flock-fg',
};

/** Single-letter badge per change kind (matches git's short status letters). */
const KIND_BADGE: Record<GitFileStatus['kind'], { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'text-diff-add' },
  modified: { letter: 'M', cls: 'text-flock-accent' },
  deleted: { letter: 'D', cls: 'text-diff-remove' },
  renamed: { letter: 'R', cls: 'text-flock-accent' },
  copied: { letter: 'C', cls: 'text-flock-accent' },
  typechange: { letter: 'T', cls: 'text-flock-accent' },
  untracked: { letter: 'U', cls: 'text-flock-muted' },
  unmerged: { letter: '!', cls: 'text-status-error' },
};

export interface SourceControlPanelProps {
  sessionId: string;
}

export default function SourceControlPanel({ sessionId }: SourceControlPanelProps): JSX.Element {
  const status = useGitStatus(sessionId);
  const selectedPath = usePaddock((s) => s.diffSelectedPath);
  const selectedStaged = usePaddock((s) => s.diffSelectedStaged);
  const selectFile = usePaddock((s) => s.selectDiffFile);

  // A file is being previewed → show its scoped diff with a back affordance.
  if (selectedPath != null) {
    return (
      <FileDiffPreview
        sessionId={sessionId}
        path={selectedPath}
        staged={selectedStaged}
        onBack={() => selectFile(null)}
      />
    );
  }

  if (status.isLoading) {
    return <Centered testid="sc-loading">Loading changes…</Centered>;
  }
  if (status.isError) {
    const message =
      status.error instanceof Error ? status.error.message : 'Could not load source control.';
    return (
      <Centered testid="sc-error" tone="error">
        {message}
      </Centered>
    );
  }

  // `null` = the working dir isn't a git repo (the 422 verdict, cached once).
  if (status.data == null) {
    return (
      <Centered testid="sc-not-repo">
        This working directory isn’t a git repository, so there’s nothing to review.
      </Centered>
    );
  }

  const data = status.data;
  const staged = data.files.filter((f) => f.staged);
  const changes = data.files.filter((f) => f.unstaged);

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="source-control">
      <BranchHeader
        sessionId={sessionId}
        branch={data.branch}
        ahead={data.ahead}
        behind={data.behind}
        onRefresh={() => void status.refetch()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileGroup
          title="Staged changes"
          testid="sc-staged"
          files={staged}
          sessionId={sessionId}
          group="staged"
        />
        <FileGroup
          title="Changes"
          testid="sc-changes"
          files={changes}
          sessionId={sessionId}
          group="changes"
        />
        {staged.length === 0 && changes.length === 0 ? (
          <p
            data-testid="sc-clean"
            className="px-3 py-6 text-center text-sm text-flock-muted"
          >
            No changes in the working directory.
          </p>
        ) : null}
      </div>
      <CommitBar sessionId={sessionId} stagedCount={staged.length} ahead={data.ahead} />
    </div>
  );
}

function BranchHeader({
  sessionId,
  branch,
  ahead,
  behind,
  onRefresh,
}: {
  sessionId: string;
  branch: string | null;
  ahead: number;
  behind: number;
  onRefresh: () => void;
}): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const createBranch = useCreateBranch(sessionId);
  const submit = (): void => {
    const n = name.trim();
    if (!n) return;
    createBranch.mutate({ name: n }, { onSuccess: () => { setName(''); setCreating(false); } });
  };
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3 text-xs">
      {creating ? (
        <input
          data-testid="sc-branch-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setCreating(false);
          }}
          placeholder="new-branch-name"
          className="min-w-0 flex-1 rounded border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-0.5 text-flock-fg placeholder:text-flock-muted focus:outline-none focus:ring-1 focus:ring-flock-accent"
        />
      ) : (
        <>
          <span className="font-medium text-flock-ink-primary" data-testid="sc-branch">
            {branch ?? 'detached'}
          </span>
          {ahead > 0 ? <span className="text-flock-muted">↑{ahead}</span> : null}
          {behind > 0 ? <span className="text-flock-muted">↓{behind}</span> : null}
        </>
      )}
      <button
        type="button"
        data-testid="sc-new-branch"
        onClick={() => (creating ? submit() : setCreating(true))}
        aria-label="New branch"
        title="Create a new branch from here"
        className="ml-auto rounded p-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
      >
        <GitBranchPlus className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
        className="rounded p-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
      >
        <RefreshCw className="size-3.5" />
      </button>
    </div>
  );
}

function FileGroup({
  title,
  testid,
  files,
  sessionId,
  group,
}: {
  title: string;
  testid: string;
  files: GitFileStatus[];
  sessionId: string;
  group: 'staged' | 'changes';
}): JSX.Element | null {
  const stage = useStageFiles(sessionId);
  const unstage = useUnstageFiles(sessionId);
  const selectFile = usePaddock((s) => s.selectDiffFile);
  if (files.length === 0) return null;

  const bulk = group === 'staged' ? () => unstage.mutate([]) : () => stage.mutate([]);
  return (
    <section data-testid={testid} className="border-b border-flock-muted/10">
      <div className="flex items-center justify-between px-3 py-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-flock-muted">
          {title} ({files.length})
        </h4>
        <button
          type="button"
          onClick={bulk}
          className="text-xs text-flock-ink-muted hover:text-flock-ink-primary"
          data-testid={`${testid}-bulk`}
        >
          {group === 'staged' ? 'Unstage all' : 'Stage all'}
        </button>
      </div>
      <ul>
        {files.map((f) => {
          const badge = KIND_BADGE[f.kind];
          return (
            <li
              key={`${group}:${f.path}`}
              data-testid={`sc-file-${f.path}`}
              className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-flock-surface-2"
            >
              <span className={`w-3 shrink-0 text-center font-mono ${badge.cls}`} title={f.kind}>
                {badge.letter}
              </span>
              <button
                type="button"
                onClick={() => selectFile(f.path, group === 'staged')}
                className="min-w-0 flex-1 truncate text-left font-mono text-flock-fg hover:text-flock-ink-primary"
                title={f.path}
              >
                {f.path}
              </button>
              <button
                type="button"
                aria-label={group === 'staged' ? `Unstage ${f.path}` : `Stage ${f.path}`}
                title={group === 'staged' ? 'Unstage' : 'Stage'}
                onClick={() =>
                  group === 'staged' ? unstage.mutate([f.path]) : stage.mutate([f.path])
                }
                className="shrink-0 rounded p-0.5 text-flock-ink-muted opacity-0 hover:bg-flock-surface-1 hover:text-flock-ink-primary group-hover:opacity-100"
              >
                {group === 'staged' ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CommitBar({
  sessionId,
  stagedCount,
  ahead,
}: {
  sessionId: string;
  stagedCount: number;
  ahead: number;
}): JSX.Element {
  const [message, setMessage] = useState('');
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const commit = useCommit(sessionId);
  const push = usePush(sessionId);
  const pr = useCreatePr(sessionId);
  const canCommit = stagedCount > 0 && message.trim().length > 0 && !commit.isPending;

  return (
    <div className="shrink-0 border-t border-[var(--flock-border)] p-2">
      <textarea
        data-testid="sc-message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={stagedCount > 0 ? 'Commit message' : 'Stage changes to commit'}
        rows={2}
        className="w-full resize-none rounded border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1 text-xs text-flock-fg placeholder:text-flock-muted focus:outline-none focus:ring-1 focus:ring-flock-accent"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          data-testid="sc-commit"
          disabled={!canCommit}
          onClick={() =>
            commit.mutate(message.trim(), { onSuccess: (r) => r.committed && setMessage('') })
          }
          className="flex-1 rounded bg-flock-accent px-2 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Commit{stagedCount > 0 ? ` (${stagedCount})` : ''}
        </button>
        <button
          type="button"
          data-testid="sc-push"
          disabled={push.isPending}
          onClick={() => push.mutate()}
          title="Push to the remote"
          className="flex items-center gap-1 rounded border border-[var(--flock-border)] px-2 py-1 text-xs text-flock-ink-primary hover:bg-flock-surface-2 disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" />
          Push{ahead > 0 ? ` ${ahead}` : ''}
        </button>
        <button
          type="button"
          data-testid="sc-pr-toggle"
          onClick={() => setPrOpen((v) => !v)}
          title="Open a pull request (commit + push first)"
          className="flex items-center gap-1 rounded border border-[var(--flock-border)] px-2 py-1 text-xs text-flock-ink-primary hover:bg-flock-surface-2"
        >
          <GitPullRequest className="size-3.5" />
          PR
        </button>
      </div>

      {prOpen ? (
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--flock-border)] pt-2">
          <input
            data-testid="sc-pr-title"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="Pull request title"
            className="min-w-0 flex-1 rounded border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1 text-xs text-flock-fg placeholder:text-flock-muted focus:outline-none focus:ring-1 focus:ring-flock-accent"
          />
          <button
            type="button"
            data-testid="sc-pr-open"
            disabled={prTitle.trim().length === 0 || pr.isPending}
            onClick={() =>
              pr.mutate(
                { title: prTitle.trim() },
                {
                  onSuccess: () => {
                    setPrTitle('');
                    setPrOpen(false);
                  },
                },
              )
            }
            className="rounded bg-flock-accent px-2 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Open PR
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FileDiffPreview({
  sessionId,
  path,
  staged,
  onBack,
}: {
  sessionId: string;
  path: string;
  staged: boolean | null;
  onBack: () => void;
}): JSX.Element {
  const preview = useQuery({
    queryKey: ['file-diff', sessionId, path, staged],
    queryFn: () =>
      fetchSessionDiff(sessionId, fetch, { path, staged: staged ?? undefined }),
    retry: false,
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="sc-preview">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-2 text-xs">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to changes"
          className="rounded p-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="min-w-0 truncate font-mono text-flock-ink-primary" title={path}>
          {path}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {preview.isLoading ? (
          <Centered testid="sc-preview-loading">Loading diff…</Centered>
        ) : preview.isError ? (
          <Centered testid="sc-preview-error" tone="error">
            {preview.error instanceof Error ? preview.error.message : 'Could not load the diff.'}
          </Centered>
        ) : isEmptyDiff(preview.data?.diff ?? '') ? (
          <Centered testid="sc-preview-empty">No changes for this file.</Centered>
        ) : (
          <pre className="m-0 min-w-full p-3 font-mono text-xs leading-relaxed">
            <code>
              {parseDiff(preview.data!.diff).map((line, i) => (
                <div key={i} className={`whitespace-pre ${LINE_CLASS[line.kind]}`}>
                  {line.text === '' ? ' ' : line.text}
                </div>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}

function Centered({
  children,
  testid,
  tone,
}: {
  children: React.ReactNode;
  testid: string;
  tone?: 'error';
}): JSX.Element {
  return (
    <div
      data-testid={testid}
      className={`flex h-full w-full items-center justify-center px-4 text-center text-sm ${
        tone === 'error' ? 'text-status-error' : 'text-flock-muted'
      }`}
    >
      {children}
    </div>
  );
}
