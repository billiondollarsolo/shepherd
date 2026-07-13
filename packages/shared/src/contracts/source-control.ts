import { z } from 'zod';
import { IsoTimestamp, Uuid } from '../domain.js';

// --- diff ------------------------------------------------------------------

/** GET /api/sessions/:id/diff — read-only git diff of the working dir. */
export const DiffResponse = z.object({
  sessionId: Uuid,
  /** Unified `git diff` text (may be empty when the tree is clean). */
  diff: z.string(),
  generatedAt: IsoTimestamp,
});
export type DiffResponse = z.infer<typeof DiffResponse>;

/**
 * Query params for GET /api/sessions/:id/diff. `staged` selects which side to
 * show: omitted → the COMBINED working-tree-vs-HEAD diff (everything the agent
 * touched); `"true"` → only the staged (index-vs-HEAD) diff; `"false"` → only
 * the unstaged (worktree-vs-index) diff. `path` scopes the diff to one file (the
 * per-file preview the Source Control panel opens on click). Both are strings
 * because they arrive on the query string; the route narrows `staged`.
 */
export const DiffQuery = z.object({
  staged: z.enum(['true', 'false']).optional(),
  path: z.string().min(1).optional(),
});
export type DiffQuery = z.infer<typeof DiffQuery>;

// --- git source control (US-33.1: stage / commit / push) -------------------

/** Coarse change kind for a changed file, for the UI's per-row badge. */
export const GitFileChangeKind = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'unmerged',
]);
export type GitFileChangeKind = z.infer<typeof GitFileChangeKind>;

/**
 * One changed file from `git status --porcelain=v2`. `indexStatus` /
 * `worktreeStatus` are the raw porcelain XY codes (`.` = unmodified); `staged` /
 * `unstaged` are the derived booleans the panel groups by; `origPath` is set for
 * renames/copies (the source path).
 */
export const GitFileStatus = z.object({
  path: z.string().min(1),
  origPath: z.string().nullable(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  kind: GitFileChangeKind,
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

/** GET /api/sessions/:id/git/status — the Source Control file list + branch. */
export const GitStatusResponse = z.object({
  sessionId: Uuid,
  /** Current branch name, or null when detached. */
  branch: z.string().nullable(),
  /** Upstream tracking ref (e.g. `origin/main`), or null when none. */
  upstream: z.string().nullable(),
  /** Commits ahead of the upstream (0 when no upstream). */
  ahead: z.number().int().nonnegative(),
  /** Commits behind the upstream (0 when no upstream). */
  behind: z.number().int().nonnegative(),
  /** False for a freshly `git init`'d repo with no commits (unborn HEAD). */
  hasHead: z.boolean(),
  files: z.array(GitFileStatus),
  generatedAt: IsoTimestamp,
});
export type GitStatusResponse = z.infer<typeof GitStatusResponse>;

/**
 * POST /api/sessions/:id/git/(stage|unstage). An EMPTY `paths` array means "all
 * changes" (stage/unstage everything), matching the panel's bulk actions.
 */
export const GitStageRequest = z.object({
  paths: z.array(z.string().min(1)).default([]),
});
export type GitStageRequest = z.infer<typeof GitStageRequest>;

/** POST /api/sessions/:id/git/commit — commits the staged changes. */
export const GitCommitRequest = z.object({
  message: z.string().min(1),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequest>;

export const GitCommitResponse = z.object({
  sessionId: Uuid,
  /** False when there was nothing staged to commit (a soft no-op, not an error). */
  committed: z.boolean(),
  /** Short sha of the new commit when `committed`, else null. */
  sha: z.string().nullable(),
  /** One-line human detail (the commit summary, or why nothing happened). */
  detail: z.string(),
  generatedAt: IsoTimestamp,
});
export type GitCommitResponse = z.infer<typeof GitCommitResponse>;

/**
 * POST /api/sessions/:id/git/push response. Push runs with the NODE's own git
 * credentials (Shepherd's SSH connection is to the node, not to the git remote), so
 * `detail` carries git's output verbatim for the user to read.
 */
export const GitPushResponse = z.object({
  sessionId: Uuid,
  pushed: z.literal(true),
  detail: z.string(),
  generatedAt: IsoTimestamp,
});
export type GitPushResponse = z.infer<typeof GitPushResponse>;

// --- branches + pull requests (roadmap P5: close the git loop) -------------

/** GET /api/sessions/:id/git/branches — local branches + the current one. */
export const GitBranchesResponse = z.object({
  sessionId: Uuid,
  current: z.string().nullable(),
  branches: z.array(z.string()),
  generatedAt: IsoTimestamp,
});
export type GitBranchesResponse = z.infer<typeof GitBranchesResponse>;

/** POST /api/sessions/:id/git/branch — create a branch (and switch to it). */
export const CreateBranchRequest = z.object({
  name: z.string().min(1),
  /** Optional start point (ref/branch/sha); defaults to current HEAD. */
  from: z.string().min(1).optional(),
});
export type CreateBranchRequest = z.infer<typeof CreateBranchRequest>;

/** POST /api/sessions/:id/git/switch — switch to an existing branch. */
export const SwitchBranchRequest = z.object({ name: z.string().min(1) });
export type SwitchBranchRequest = z.infer<typeof SwitchBranchRequest>;

/** Response for create-branch / switch-branch — the resulting current branch. */
export const GitBranchResponse = z.object({
  sessionId: Uuid,
  branch: z.string(),
  created: z.boolean(),
  detail: z.string(),
  generatedAt: IsoTimestamp,
});
export type GitBranchResponse = z.infer<typeof GitBranchResponse>;

/** POST /api/sessions/:id/git/pr — open (or find an existing) GitHub PR. */
export const CreatePrRequest = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  /** Base branch; defaults to the repo's default branch (gh decides). */
  base: z.string().min(1).optional(),
  draft: z.boolean().optional(),
});
export type CreatePrRequest = z.infer<typeof CreatePrRequest>;

/** Result of opening a PR — the URL, whether we created it or found an existing one. */
export const GitPrResponse = z.object({
  sessionId: Uuid,
  url: z.string(),
  /** True if we opened a new PR; false if an open PR for this branch already existed. */
  created: z.boolean(),
  detail: z.string(),
  generatedAt: IsoTimestamp,
});
export type GitPrResponse = z.infer<typeof GitPrResponse>;

// --- API error envelope (roadmap F2) ---------------------------------------

/**
 * The single error shape every REST route + the global handler return:
 * `{ error: { code, message, details? } }`. `code` is a stable, machine-readable
 * discriminator the web client can branch on (vs parsing the message).
 */
export const FlockErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type FlockErrorEnvelope = z.infer<typeof FlockErrorEnvelope>;
