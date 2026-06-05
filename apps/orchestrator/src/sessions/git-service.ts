/**
 * GitService — US-33.1: the WRITE side of the session diff feature (stage /
 * unstage / commit / push), the Codex "review loop." Where {@link DiffService}
 * is read-only, this runs the mutating git plumbing ON THE NODE via its
 * {@link NodeTransport} (the node stays a dumb courier — the orchestrator hands
 * it the exact argv, spec §4.3/§5.1).
 *
 *   GET  /api/sessions/:id/git/status      file list + branch/ahead/behind
 *   POST /api/sessions/:id/git/stage       git add  (empty paths → all)
 *   POST /api/sessions/:id/git/unstage     git reset/rm --cached (empty → all)
 *   POST /api/sessions/:id/git/commit      git commit -m … (Flock user identity)
 *   POST /api/sessions/:id/git/push        git push (node's own remote creds)
 *
 * It reuses {@link DiffService}'s injectable session-lookup + transport-resolver
 * seams so production wires it with the SAME Drizzle registry + per-node
 * transport, and unit tests inject fakes (no real git/tmux/Postgres).
 *
 * Like the diff, this is NOT on the live status path (NFR-PERF1): it runs on
 * demand when the user acts in the Source Control panel.
 */
import type { GitCommitResponse, GitPushResponse, GitStatusResponse } from '@flock/shared';

import type { ExecResult, NodeTransport } from '../nodes/transport/transport.js';
import {
  DiffSessionNotFoundError,
  GIT_EMPTY_TREE,
  gitHasHeadArgv,
  summarizeGitError,
  type DiffSessionLookup,
  type DiffTransportResolver,
} from './diff-service.js';

/** Thrown when a git operation fails (not-a-repo, push rejected, …) → HTTP 422. */
export class GitOperationError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'GitOperationError';
  }
}

/** The committer/author identity injected per-commit (the acting Flock user). */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

// --- porcelain v2 parsing --------------------------------------------------

/** A single changed file parsed from `git status --porcelain=v2`. */
export interface ParsedGitFile {
  path: string;
  origPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  kind: GitStatusResponse['files'][number]['kind'];
}

/** The fully-parsed `git status --porcelain=v2 --branch -z` output. */
export interface ParsedGitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasHead: boolean;
  files: ParsedGitFile[];
}

function classifyKind(
  indexStatus: string,
  worktreeStatus: string,
  untracked: boolean,
  unmerged: boolean,
): ParsedGitFile['kind'] {
  if (untracked) return 'untracked';
  if (unmerged) return 'unmerged';
  // Prefer the index (staged) code; fall back to the worktree code.
  const code = indexStatus !== '.' ? indexStatus : worktreeStatus;
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case 'M':
    default:
      return 'modified';
  }
}

function makeFile(xy: string, path: string, origPath: string | null): ParsedGitFile {
  const untracked = xy === '??';
  const indexStatus = untracked ? '?' : (xy[0] ?? '.');
  const worktreeStatus = untracked ? '?' : (xy[1] ?? '.');
  const unmerged = !untracked && (indexStatus === 'U' || worktreeStatus === 'U');
  return {
    path,
    origPath,
    indexStatus,
    worktreeStatus,
    staged: !untracked && !unmerged && indexStatus !== '.',
    unstaged: untracked || worktreeStatus !== '.',
    kind: classifyKind(indexStatus, worktreeStatus, untracked, unmerged),
  };
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. The `-z` form is NUL-separated
 * and unambiguous: header lines start `# `; changed entries start `1 `/`2 `/`u `;
 * untracked `? `; ignored `! `. A rename/copy (`2 `) entry is followed by ONE
 * extra NUL-separated field — its original path — which we consume.
 *
 * Exported so the parser is unit-tested directly (the porcelain format IS the
 * contract; the node only runs the argv we hand it).
 */
export function parseGitStatusV2(out: string): ParsedGitStatus {
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const result: ParsedGitStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasHead: true,
    files: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (tok.startsWith('# ')) {
      const rest = tok.slice(2);
      if (rest.startsWith('branch.oid ')) {
        result.hasHead = rest.slice('branch.oid '.length).trim() !== '(initial)';
      } else if (rest.startsWith('branch.head ')) {
        const v = rest.slice('branch.head '.length).trim();
        result.branch = v === '(detached)' ? null : v;
      } else if (rest.startsWith('branch.upstream ')) {
        result.upstream = rest.slice('branch.upstream '.length).trim() || null;
      } else if (rest.startsWith('branch.ab ')) {
        const m = rest.slice('branch.ab '.length).match(/\+(-?\d+)\s+-(-?\d+)/);
        if (m) {
          result.ahead = Math.abs(Number(m[1]));
          result.behind = Math.abs(Number(m[2]));
        }
      }
      continue;
    }
    if (tok.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const sp = tok.split(' ');
      result.files.push(makeFile(sp[1] ?? '..', sp.slice(8).join(' '), null));
    } else if (tok.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path> ; next token = origPath
      const sp = tok.split(' ');
      const path = sp.slice(9).join(' ');
      const origPath = tokens[i + 1] ?? null;
      i += 1; // consume the original-path field
      result.files.push(makeFile(sp[1] ?? '..', path, origPath));
    } else if (tok.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const sp = tok.split(' ');
      result.files.push(makeFile(sp[1] ?? 'UU', sp.slice(10).join(' '), null));
    } else if (tok.startsWith('? ')) {
      result.files.push(makeFile('??', tok.slice(2), null));
    }
    // '! ' (ignored) entries are intentionally skipped.
  }

  return result;
}

// --- argv builders (exported for the unit test; argv IS the contract) ------

export function gitStatusArgv(workingDir: string): string[] {
  return ['git', '-C', workingDir, 'status', '--porcelain=v2', '--branch', '-z'];
}

export function gitStageArgv(workingDir: string, paths: readonly string[]): string[] {
  // `-A` stages adds, modifications AND deletions for the given pathspecs (or
  // the whole tree when none are given).
  return paths.length === 0
    ? ['git', '-C', workingDir, 'add', '-A']
    : ['git', '-C', workingDir, 'add', '-A', '--', ...paths];
}

export function gitUnstageArgv(
  workingDir: string,
  paths: readonly string[],
  hasHead: boolean,
): string[] {
  if (hasHead) {
    // Reset the index entry(ies) back to HEAD — the canonical "unstage".
    return paths.length === 0
      ? ['git', '-C', workingDir, 'reset', '-q']
      : ['git', '-C', workingDir, 'reset', '-q', '--', ...paths];
  }
  // Unborn branch (no HEAD): there is nothing to reset TO, so drop the entry
  // from the index with `rm --cached` (the file stays on disk as untracked).
  return paths.length === 0
    ? ['git', '-C', workingDir, 'rm', '-r', '--cached', '-q', '--', '.']
    : ['git', '-C', workingDir, 'rm', '-r', '--cached', '-q', '--', ...paths];
}

export function gitCommitArgv(
  workingDir: string,
  message: string,
  identity: GitIdentity,
): string[] {
  // Pass identity via -c so a commit succeeds even on a node with no global git
  // config (a fresh SSH node) — the acting Flock user is the author/committer.
  return [
    'git',
    '-C',
    workingDir,
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    'commit',
    '-m',
    message,
  ];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 60_000;

export class GitService {
  private readonly sessions: DiffSessionLookup;
  private readonly transports: DiffTransportResolver;
  private readonly timeoutMs: number;

  constructor(deps: {
    sessions: DiffSessionLookup;
    transports: DiffTransportResolver;
    options?: { timeoutMs?: number };
  }) {
    this.sessions = deps.sessions;
    this.transports = deps.transports;
    this.timeoutMs = deps.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async resolve(
    sessionId: string,
  ): Promise<{ workingDir: string; transport: NodeTransport }> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new DiffSessionNotFoundError(sessionId);
    const transport = await this.transports.transportForNode(session.nodeId);
    if (!transport) throw new GitOperationError('the session node is not reachable.');
    return { workingDir: session.workingDir, transport };
  }

  private async run(
    transport: NodeTransport,
    workingDir: string,
    argv: string[],
    timeoutMs = this.timeoutMs,
  ): Promise<ExecResult> {
    let result: ExecResult;
    try {
      result = await transport.exec(argv, { cwd: workingDir, timeoutMs });
    } catch (err) {
      throw new GitOperationError(err instanceof Error ? err.message : 'git command failed.');
    }
    if (result.timedOut) throw new GitOperationError('git command timed out.');
    return result;
  }

  private async hasHead(transport: NodeTransport, workingDir: string): Promise<boolean> {
    try {
      const r = await transport.exec(gitHasHeadArgv(workingDir), {
        cwd: workingDir,
        timeoutMs: this.timeoutMs,
      });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** The Source Control file list + branch/ahead/behind for a session. */
  async status(sessionId: string): Promise<GitStatusResponse> {
    const { workingDir, transport } = await this.resolve(sessionId);
    const r = await this.run(transport, workingDir, gitStatusArgv(workingDir));
    if (r.exitCode !== 0) {
      throw new GitOperationError(summarizeGitError(r.stderr, r.exitCode));
    }
    const parsed = parseGitStatusV2(r.stdout);
    return {
      sessionId,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      hasHead: parsed.hasHead,
      files: parsed.files,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Stage the given paths (or everything when empty). Returns fresh status. */
  async stage(sessionId: string, paths: readonly string[]): Promise<GitStatusResponse> {
    const { workingDir, transport } = await this.resolve(sessionId);
    const r = await this.run(transport, workingDir, gitStageArgv(workingDir, paths));
    if (r.exitCode !== 0) throw new GitOperationError(summarizeGitError(r.stderr, r.exitCode));
    return this.status(sessionId);
  }

  /** Unstage the given paths (or everything when empty). Returns fresh status. */
  async unstage(sessionId: string, paths: readonly string[]): Promise<GitStatusResponse> {
    const { workingDir, transport } = await this.resolve(sessionId);
    const hasHead = await this.hasHead(transport, workingDir);
    const r = await this.run(transport, workingDir, gitUnstageArgv(workingDir, paths, hasHead));
    if (r.exitCode !== 0) throw new GitOperationError(summarizeGitError(r.stderr, r.exitCode));
    return this.status(sessionId);
  }

  /** Commit the staged changes as the acting Flock user. */
  async commit(
    sessionId: string,
    message: string,
    identity: GitIdentity,
  ): Promise<GitCommitResponse> {
    const { workingDir, transport } = await this.resolve(sessionId);
    const r = await this.run(transport, workingDir, gitCommitArgv(workingDir, message, identity));

    if (r.exitCode !== 0) {
      // "nothing to commit" is a soft no-op, not a failure the UI should alarm on.
      if (/nothing to commit|no changes added/i.test(`${r.stdout}\n${r.stderr}`)) {
        return {
          sessionId,
          committed: false,
          sha: null,
          detail: 'Nothing staged to commit.',
          generatedAt: new Date().toISOString(),
        };
      }
      throw new GitOperationError(summarizeGitError(r.stderr || r.stdout, r.exitCode));
    }

    let sha: string | null = null;
    try {
      const rev = await transport.exec(['git', '-C', workingDir, 'rev-parse', '--short', 'HEAD'], {
        cwd: workingDir,
        timeoutMs: this.timeoutMs,
      });
      if (rev.exitCode === 0) sha = rev.stdout.trim() || null;
    } catch {
      /* sha is best-effort decoration */
    }

    const summary =
      r.stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? 'Committed.';
    return {
      sessionId,
      committed: true,
      sha,
      detail: summary,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Push the current branch. Runs with the NODE's own git credentials (Flock's
   * SSH connection is to the node, not the git remote). Falls back to setting the
   * upstream when none is configured. Throws {@link GitOperationError} (→422)
   * with git's verbatim output on failure so the user can act on it.
   */
  async push(sessionId: string): Promise<GitPushResponse> {
    const { workingDir, transport } = await this.resolve(sessionId);

    let r = await this.run(transport, workingDir, ['git', '-C', workingDir, 'push'], PUSH_TIMEOUT_MS);
    if (r.exitCode !== 0 && /no upstream branch|--set-upstream/i.test(r.stderr)) {
      r = await this.run(
        transport,
        workingDir,
        ['git', '-C', workingDir, 'push', '-u', 'origin', 'HEAD'],
        PUSH_TIMEOUT_MS,
      );
    }

    // git push writes progress to stderr even on success — combine both streams.
    const detail = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n') || 'Pushed.';
    if (r.exitCode !== 0) {
      throw new GitOperationError(detail);
    }
    return { sessionId, pushed: true, detail, generatedAt: new Date().toISOString() };
  }
}
