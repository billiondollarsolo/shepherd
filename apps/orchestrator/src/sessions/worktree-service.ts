/**
 * WorktreeService — per-session git worktrees for ISOLATED parallel work (the
 * Orca model; Codex-cloud's "isolated env + branch" in spirit). When a session
 * opts in, it runs in its OWN git worktree on its OWN branch, so multiple agents
 * can work the same repo at once without colliding on files or git state; you
 * review each branch's diff (the Source Control panel) and merge it back.
 *
 * Mirrors the GitService model: the orchestrator hands the node the exact git
 * argv over its {@link NodeTransport} (the node stays a dumb courier). All paths
 * + branch names are computed here.
 *
 * Lifecycle:
 *   create()  → git worktree add --no-track -b <branch> <path> HEAD   (+ config)
 *   remove()  → git worktree remove --force <path>; prune; branch -d  (merge-safe)
 */
import type { ExecResult, NodeTransport } from '../nodes/transport/transport.js';

/** Resolves a node's transport (production: the connection manager; tests: fake). */
export type WorktreeTransportResolver = (nodeId: string) => Promise<NodeTransport>;

export class WorktreeError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'WorktreeError';
  }
}

export interface CreatedWorktree {
  /** Absolute path of the new worktree on the node (becomes the session cwd). */
  path: string;
  /** The branch checked out in the worktree. */
  branch: string;
}

/** Sanitize a user/branch name into a safe git branch segment. */
export function sanitizeBranchSegment(raw: string): string {
  const s = raw
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, '-') // git-unsafe → '-'
    .replace(/^[-.]+|[-.]+$/g, '') // no leading/trailing . or -
    .replace(/\.\.+/g, '-') // no '..'
    .replace(/\/+/g, '/')
    .slice(0, 100);
  return s || 'session';
}

export interface WorktreeServiceDeps {
  transports: WorktreeTransportResolver;
  timeoutMs?: number;
}

export class WorktreeService {
  private readonly transports: WorktreeTransportResolver;
  private readonly timeoutMs: number;

  constructor(deps: WorktreeServiceDeps) {
    this.transports = deps.transports;
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  /**
   * Create a worktree for `branch` off HEAD of the repo at `repoDir` on `nodeId`.
   * The worktree lives in a sibling `.flock-worktrees/<repo>/<branch>` dir (never
   * nested inside the repo). Throws {@link WorktreeError} if `repoDir` isn't a git
   * repo or the branch already exists.
   */
  async create(nodeId: string, repoDir: string, branch: string): Promise<CreatedWorktree> {
    const transport = await this.transports(nodeId);
    const safeBranch = sanitizeBranchSegment(branch);

    // 1) repoDir must be a git repo → resolve its top-level.
    const top = await this.exec(transport, repoDir, [
      'git', '-C', repoDir, 'rev-parse', '--show-toplevel',
    ]);
    if (top.exitCode !== 0) {
      throw new WorktreeError(
        `Working dir is not a git repository (worktree requires git): ${repoDir}`,
      );
    }
    const repoTop = top.stdout.trim();
    const repoName = baseName(repoTop);
    const parent = dirName(repoTop);
    // Sibling root so worktrees never nest inside the repo's own tree.
    const wtPath = `${parent}/.flock-worktrees/${repoName}/${pathSafe(safeBranch)}`;

    // 2) create the worktree on a fresh branch off HEAD. --no-track mirrors Orca
    //    (don't inherit the base's upstream; set on first push instead).
    const add = await this.exec(transport, repoTop, [
      'git', '-C', repoTop, 'worktree', 'add', '--no-track', '-b', safeBranch, wtPath, 'HEAD',
    ]);
    if (add.exitCode !== 0) {
      throw new WorktreeError(`git worktree add failed: ${oneLine(add.stderr || add.stdout)}`);
    }

    // 3) best-effort: auto-set upstream on first push (ergonomics, like Orca).
    await this.exec(transport, repoTop, [
      'git', '-C', repoTop, 'config', 'push.autoSetupRemote', 'true',
    ]).catch(() => undefined);

    return { path: wtPath, branch: safeBranch };
  }

  /**
   * Remove a session's worktree + delete its branch if safely merged (handles the
   * squash-merge shape: try `-d`, and if the branch tip is an ancestor of HEAD it
   * was merged so force-delete; otherwise PRESERVE the branch so unmerged work is
   * never lost). Best-effort + idempotent — a missing worktree is fine.
   */
  async remove(nodeId: string, worktreePath: string, branch: string): Promise<void> {
    let transport: NodeTransport;
    try {
      transport = await this.transports(nodeId);
    } catch {
      return; // node unreachable — nothing we can do; daemon/reaper handles it
    }
    // Find the main worktree (first entry of `worktree list`) to run removal from.
    const list = await this.exec(transport, worktreePath, [
      'git', '-C', worktreePath, 'worktree', 'list', '--porcelain',
    ]).catch(() => null);
    const mainTop = list && list.exitCode === 0 ? firstWorktreePath(list.stdout) : null;
    if (!mainTop) return; // already gone / not a worktree

    await this.exec(transport, mainTop, [
      'git', '-C', mainTop, 'worktree', 'remove', '--force', worktreePath,
    ]).catch(() => undefined);
    await this.exec(transport, mainTop, ['git', '-C', mainTop, 'worktree', 'prune']).catch(
      () => undefined,
    );

    if (!branch) return;
    const del = await this.exec(transport, mainTop, ['git', '-C', mainTop, 'branch', '-d', branch]);
    if (del.exitCode === 0) return;
    // -d refused (commits not on the current HEAD by id). If the branch tip IS an
    // ancestor of HEAD (e.g. squash/rebase already integrated), it's safe to drop.
    const merged = await this.exec(transport, mainTop, [
      'git', '-C', mainTop, 'merge-base', '--is-ancestor', branch, 'HEAD',
    ]);
    if (merged.exitCode === 0) {
      await this.exec(transport, mainTop, ['git', '-C', mainTop, 'branch', '-D', branch]).catch(
        () => undefined,
      );
    }
    // else: unmerged work — PRESERVE the branch (the user can merge/delete it).
  }

  /**
   * Merge a session's worktree branch into a target branch in the main repo
   * (no-fast-forward, so it's a reviewable merge commit). Returns the merge
   * output. Throws on conflicts/failure so the caller can surface it.
   */
  async merge(nodeId: string, worktreePath: string, branch: string, into: string): Promise<string> {
    const transport = await this.transports(nodeId);
    const list = await this.exec(transport, worktreePath, [
      'git', '-C', worktreePath, 'worktree', 'list', '--porcelain',
    ]);
    const mainTop = list.exitCode === 0 ? firstWorktreePath(list.stdout) : null;
    if (!mainTop) throw new WorktreeError('Could not locate the main repository for this worktree.');
    // Merge from a checkout of `into`: do it in the main worktree, which must be on
    // `into` (or we check it out). Keep it simple + safe: require main on `into`.
    const cur = await this.exec(transport, mainTop, [
      'git', '-C', mainTop, 'rev-parse', '--abbrev-ref', 'HEAD',
    ]);
    if (cur.stdout.trim() !== into) {
      throw new WorktreeError(
        `Main repo is on '${cur.stdout.trim()}', not '${into}'. Check out '${into}' there first.`,
      );
    }
    const res = await this.exec(transport, mainTop, [
      'git', '-C', mainTop, 'merge', '--no-ff', '-m', `Merge ${branch} (Flock session)`, branch,
    ]);
    if (res.exitCode !== 0) {
      // abort a conflicted merge so the repo isn't left mid-merge
      await this.exec(transport, mainTop, ['git', '-C', mainTop, 'merge', '--abort']).catch(
        () => undefined,
      );
      throw new WorktreeError(`Merge failed: ${oneLine(res.stderr || res.stdout)}`);
    }
    return res.stdout.trim();
  }

  private async exec(transport: NodeTransport, cwd: string, argv: string[]): Promise<ExecResult> {
    try {
      return await transport.exec(argv, { cwd, timeoutMs: this.timeoutMs });
    } catch (err) {
      throw new WorktreeError(err instanceof Error ? err.message : 'git command failed');
    }
  }
}

// --- small path/parse helpers (POSIX node paths) ---------------------------
function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || 'repo';
}
function dirName(p: string): string {
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
}
function pathSafe(branch: string): string {
  return branch.replace(/\//g, '-');
}
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** First `worktree <path>` line of `git worktree list --porcelain` (the main one). */
function firstWorktreePath(porcelain: string): string | null {
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) return line.slice('worktree '.length).trim();
  }
  return null;
}
