/**
 * DiffService — US-33 (FR-UI4, spec §8.1): read-only `git diff` of a session's
 * working dir for the center pane's Diff tab.
 *
 *   GET /api/sessions/:id/diff   →   { sessionId, diff, generatedAt }
 *
 * This is intentionally READ-ONLY: v1 ships the diff as a viewer only; stage /
 * commit / PR are deferred to v1.x (spec §4.2 out-of-scope). The diff is
 * produced by running `git` ON THE NODE via its {@link NodeTransport} — the node
 * is a DUMB COURIER (PRD §6.4, spec §4.3/§5.1): the orchestrator hands it the
 * exact argv and the node runs nothing else.
 *
 * It is NOT on the live status path (spec §6.6, NFR-PERF1): this runs on demand
 * when the user opens the Diff tab, never on a per-transition basis, so reading
 * the registry to resolve the working dir is fine here.
 *
 * Collaborators are injected behind small interfaces so the service is unit-
 * testable without real git, tmux, or Postgres. Production wiring passes the
 * Drizzle-backed session registry and a per-node {@link NodeTransport}.
 */
import type { DiffResponse } from '@flock/shared';

import type { ExecResult, NodeCommandTransport } from '../nodes/transport/transport.js';

/**
 * Thrown when no session record exists for the given id (maps to HTTP 404).
 *
 * Named distinctly from the terminate service's `SessionNotFoundError` so the
 * `sessions/index.js` barrel (`export *`) has no symbol collision.
 */
export class DiffSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No session found for id ${sessionId}.`);
    this.name = 'DiffSessionNotFoundError';
  }
}

/** Thrown when `git diff` itself fails (e.g. not a git repo) — maps to 422. */
export class DiffUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`Unable to produce a diff for session ${sessionId}: ${detail}`);
    this.name = 'DiffUnavailableError';
  }
}

/**
 * The minimal session-record lookup the diff service needs: it resolves the
 * working dir + the node the session lives on. Satisfied by the in-memory
 * SessionCreateService binding AND by the Drizzle registry (both expose enough
 * shape); tests inject a fake. We accept a narrow shape so we depend on neither
 * concrete type and never duplicate the shared `Session` type.
 */
export interface DiffSessionLookup {
  /**
   * Resolve the session's working dir + node id by session_id, or null when no
   * such session exists. The returned `workingDir` is where `git diff` runs.
   */
  getSession(id: string): Promise<DiffSessionInfo | null> | DiffSessionInfo | null;
}

/** The fields {@link DiffService} needs from the authoritative session record. */
export interface DiffSessionInfo {
  readonly id: string;
  readonly nodeId: string;
  readonly workingDir: string;
}

/**
 * Resolves the {@link NodeTransport} for a node id. Production supplies the
 * per-node managed command transport; tests inject a
 * fake transport. Returns null when the node has no live transport.
 */
export interface DiffTransportResolver {
  transportForNode(
    nodeId: string,
  ): Promise<NodeCommandTransport | null> | NodeCommandTransport | null;
}

/** Optional knobs (kept tiny; defaults match a sensible read-only diff). */
export interface DiffServiceOptions {
  /**
   * Max ms a `git diff` may run before being killed. Keeps a runaway repo from
   * hanging the request. Default 10s.
   */
  timeoutMs?: number;
}

/**
 * Build the argv for the read-only working-tree diff. `git -C <dir>` scopes the
 * command to the working dir without changing the orchestrator's cwd. We diff
 * the FULL working tree (tracked changes, staged + unstaged) with `HEAD` so the
 * user sees everything the agent has touched this turn:
 *   `git -C <dir> --no-pager diff --no-color HEAD`
 * `--no-color` keeps the payload plain text (the UI applies its own diff theme
 * tokens); `--no-pager` prevents git from trying to invoke a pager.
 *
 * Exported for the unit test so the exact command is asserted (the node is a
 * dumb courier; the argv IS the contract).
 */
export function gitDiffArgv(workingDir: string, base = 'HEAD'): string[] {
  return ['git', '-C', workingDir, '--no-pager', 'diff', '--no-color', base];
}

/** Which side of the index to diff, and an optional single-file scope. */
export interface DiffOptions {
  /**
   * `undefined` → the COMBINED working-tree-vs-`base` diff (everything the agent
   * touched, staged + unstaged). `true` → the staged (`--cached`, index-vs-base)
   * diff. `false` → the unstaged (worktree-vs-index) diff.
   */
  staged?: boolean;
  /** Scope the diff to a single file (the panel's per-file preview). */
  path?: string;
}

/**
 * Build the diff argv for the requested {@link DiffOptions}. Mirrors
 * {@link gitDiffArgv} for the default (combined) case so existing callers are
 * unchanged; adds `--cached` for the staged side, drops the base for the
 * unstaged side, and appends `-- <path>` to scope to one file.
 */
export function buildDiffArgv(workingDir: string, base: string, opts: DiffOptions = {}): string[] {
  const argv = ['git', '-C', workingDir, '--no-pager', 'diff', '--no-color'];
  if (opts.staged === true) argv.push('--cached', base);
  else if (opts.staged === false) {
    /* worktree vs index: no base */
  } else argv.push(base);
  if (opts.path) argv.push('--', opts.path);
  return argv;
}

/**
 * Untracked files produce an empty `git diff` (they aren't in the index). For a
 * single-file preview, diff the path against `/dev/null` with `--no-index` so the
 * Source Control panel can still show the full file as an add.
 *
 * NOTE: `git diff --no-index` exits 1 when the files differ (same as GNU diff);
 * callers must treat exit 0/1 as success.
 */
export function gitUntrackedDiffArgv(workingDir: string, path: string): string[] {
  return [
    'git',
    '-C',
    workingDir,
    '--no-pager',
    'diff',
    '--no-color',
    '--no-index',
    '--',
    '/dev/null',
    path,
  ];
}

/**
 * `git rev-parse --verify -q HEAD` — exits 0 iff HEAD resolves (the repo has at
 * least one commit). A freshly `git init`'d repo has NO commits, so `diff HEAD`
 * would fatal ("ambiguous argument 'HEAD'"); we detect that and diff against the
 * empty-tree object instead so the staged/tracked changes still render.
 */
export function gitHasHeadArgv(workingDir: string): string[] {
  return ['git', '-C', workingDir, 'rev-parse', '--verify', '-q', 'HEAD'];
}

/** The well-known empty-tree object id — the base for a repo with no commits. */
export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Turn git's failure stderr into ONE concise, user-facing line. git dumps its
 * entire `diff` usage text when it can't run (e.g. outside a repo); we never
 * forward that wall — map the common case and otherwise take the first line.
 */
export function summarizeGitError(stderr: string, exitCode: number | null): string {
  if (/not a git repository/i.test(stderr)) {
    return 'This working directory is not a git repository.';
  }
  const firstLine = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^usage:/i.test(l));
  return firstLine ?? `git exited with code ${exitCode ?? 'unknown'}.`;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class DiffService {
  private readonly sessions: DiffSessionLookup;
  private readonly transports: DiffTransportResolver;
  private readonly timeoutMs: number;

  constructor(deps: {
    sessions: DiffSessionLookup;
    transports: DiffTransportResolver;
    options?: DiffServiceOptions;
  }) {
    this.sessions = deps.sessions;
    this.transports = deps.transports;
    this.timeoutMs = deps.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Produce the read-only diff for a session. Resolves the session's working dir
   * + node, runs `git diff` on that node via its transport, and returns the
   * shared {@link DiffResponse}. A clean tree yields an EMPTY diff string (not an
   * error) — that is a valid, expected result the UI renders as "no changes".
   *
   * Throws {@link SessionNotFoundError} (→404) for an unknown session and
   * {@link DiffUnavailableError} (→422) when git itself fails (e.g. the working
   * dir is not a git repository).
   */
  async getDiff(sessionId: string, opts: DiffOptions = {}): Promise<DiffResponse> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new DiffSessionNotFoundError(sessionId);
    }

    const transport = await this.transports.transportForNode(session.nodeId);
    if (!transport) {
      throw new DiffUnavailableError(sessionId, 'the session node is not reachable.');
    }

    // A fresh `git init` has no HEAD → diff against the empty tree instead of
    // HEAD (which would fatal "ambiguous argument 'HEAD'"). The base is only used
    // by the combined (default) and staged (`--cached`) diffs; the unstaged
    // (worktree-vs-index) diff needs no base, so skip the probe for it.
    let base = 'HEAD';
    if (opts.staged !== false) {
      try {
        const head = await transport.exec(gitHasHeadArgv(session.workingDir), {
          cwd: session.workingDir,
          timeoutMs: this.timeoutMs,
        });
        if (head.exitCode !== 0) base = GIT_EMPTY_TREE;
      } catch {
        /* best-effort; fall back to HEAD and let the diff error surface */
      }
    }

    let result: ExecResult;
    try {
      result = await transport.exec(buildDiffArgv(session.workingDir, base, opts), {
        cwd: session.workingDir,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw new DiffUnavailableError(
        sessionId,
        err instanceof Error ? err.message : 'git diff failed.',
      );
    }

    if (result.timedOut) {
      throw new DiffUnavailableError(sessionId, 'git diff timed out.');
    }

    // A non-zero exit from `git diff` means git could not run (e.g. "not a git
    // repository"), NOT "there are changes" — plain `diff` returns 0 whether or
    // not the tree is dirty. Surface a CONCISE, actionable message (git dumps its
    // whole usage text on failure; never forward that wall to the UI).
    if (result.exitCode !== 0) {
      throw new DiffUnavailableError(sessionId, summarizeGitError(result.stderr, result.exitCode));
    }

    // Untracked single-file previews: `git diff -- path` is empty because the
    // path isn't in the index. Fall back to --no-index against /dev/null so the
    // Source Control panel can still render the content.
    if (opts.path && opts.staged !== true && result.stdout.trim().length === 0) {
      try {
        const untracked = await transport.exec(
          gitUntrackedDiffArgv(session.workingDir, opts.path),
          { cwd: session.workingDir, timeoutMs: this.timeoutMs },
        );
        if (!untracked.timedOut && (untracked.exitCode === 0 || untracked.exitCode === 1)) {
          // exit 1 = "files differ" which is the normal success for --no-index.
          if (untracked.stdout.trim().length > 0) {
            result = untracked;
          }
        }
      } catch {
        /* keep the empty tracked diff */
      }
    }

    return {
      sessionId,
      diff: result.stdout,
      generatedAt: new Date().toISOString(),
    };
  }
}
