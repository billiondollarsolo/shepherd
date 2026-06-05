/**
 * US-33.1 — GitService unit tests (run under `pnpm test:unit`).
 *
 * Covers the porcelain-v2 parser (the format IS the contract) and the stage /
 * unstage / commit / push orchestration: exact argv handed to the node (dumb
 * courier), working-dir scoping, HEAD-aware unstage, identity injection on
 * commit, the "nothing to commit" soft no-op, and the push upstream fallback.
 *
 * No real git/tmux/Postgres: a scripted fake transport returns per-command
 * results so each git plumbing call is asserted in isolation.
 */
import { describe, expect, it } from 'vitest';

import { GitStatusResponse } from '@flock/shared';

import type { ExecOptions, ExecResult, NodeTransport } from '../nodes/transport/transport.js';
import { DiffSessionNotFoundError, type DiffSessionInfo } from './diff-service.js';
import {
  GitOperationError,
  GitService,
  gitCommitArgv,
  gitStageArgv,
  gitStatusArgv,
  gitUnstageArgv,
  parseGitStatusV2,
} from './git-service.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const WORKING_DIR = '/work/repo';
const IDENTITY = { name: 'mike', email: 'mike@flock.local' };

function sessionInfo(overrides: Partial<DiffSessionInfo> = {}): DiffSessionInfo {
  return { id: SESSION_ID, nodeId: NODE_ID, workingDir: WORKING_DIR, ...overrides };
}

function ok(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false };
}

/** A fake transport driven by a per-call handler so each git command is scripted. */
class ScriptedTransport implements NodeTransport {
  readonly kind = 'local' as const;
  readonly calls: string[][] = [];
  constructor(private readonly handler: (command: string[]) => ExecResult) {}
  async exec(command: string[], _options?: ExecOptions): Promise<ExecResult> {
    this.calls.push(command);
    return this.handler(command);
  }
  async openPty(): Promise<never> {
    throw new Error('unused');
  }
  async dispose(): Promise<void> {}
}

function buildService(transport: NodeTransport | null, session: DiffSessionInfo | null = sessionInfo()) {
  return new GitService({
    sessions: { getSession: async () => session },
    transports: { transportForNode: () => transport },
  });
}

describe('parseGitStatusV2', () => {
  it('parses branch, upstream, ahead/behind from the header lines', () => {
    const out = '# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +13 -2\0';
    const p = parseGitStatusV2(out);
    expect(p.branch).toBe('main');
    expect(p.upstream).toBe('origin/main');
    expect(p.ahead).toBe(13);
    expect(p.behind).toBe(2);
    expect(p.hasHead).toBe(true);
    expect(p.files).toEqual([]);
  });

  it('marks an unborn branch (no commits) as hasHead=false', () => {
    const out = '# branch.oid (initial)\0# branch.head main\0';
    expect(parseGitStatusV2(out).hasHead).toBe(false);
  });

  it('classifies a staged add, an unstaged modify, and an untracked file', () => {
    const out = [
      '# branch.head main',
      '1 A. N... 000000 100644 100644 0000 hhh src/new.ts',
      '1 .M N... 100644 100644 100644 hhh iii src/edit.ts',
      '? scratch.txt',
      '',
    ].join('\0');
    const p = parseGitStatusV2(out);
    expect(p.files).toEqual([
      expect.objectContaining({ path: 'src/new.ts', staged: true, unstaged: false, kind: 'added' }),
      expect.objectContaining({
        path: 'src/edit.ts',
        staged: false,
        unstaged: true,
        kind: 'modified',
      }),
      expect.objectContaining({
        path: 'scratch.txt',
        staged: false,
        unstaged: true,
        kind: 'untracked',
      }),
    ]);
  });

  it('treats a file staged AND with further worktree edits as both staged and unstaged', () => {
    const out = '# branch.head main\x001 MM N... 100644 100644 100644 hhh iii src/x.ts\x00';
    const [f] = parseGitStatusV2(out).files;
    expect(f).toMatchObject({ staged: true, unstaged: true, kind: 'modified' });
  });

  it('parses a rename (type 2) and consumes its original-path field', () => {
    const out = [
      '# branch.head main',
      '2 R. N... 100644 100644 100644 hhh iii R100 lib/new.ts',
      'lib/old.ts',
      '? other.txt',
      '',
    ].join('\0');
    const p = parseGitStatusV2(out);
    expect(p.files).toEqual([
      expect.objectContaining({
        path: 'lib/new.ts',
        origPath: 'lib/old.ts',
        kind: 'renamed',
        staged: true,
      }),
      expect.objectContaining({ path: 'other.txt', kind: 'untracked' }),
    ]);
  });
});

describe('git argv builders', () => {
  it('status uses porcelain v2 + branch + NUL', () => {
    expect(gitStatusArgv('/r')).toEqual([
      'git',
      '-C',
      '/r',
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
    ]);
  });

  it('stage adds everything when no paths, else scopes with --', () => {
    expect(gitStageArgv('/r', [])).toEqual(['git', '-C', '/r', 'add', '-A']);
    expect(gitStageArgv('/r', ['a.ts', 'b.ts'])).toEqual([
      'git',
      '-C',
      '/r',
      'add',
      '-A',
      '--',
      'a.ts',
      'b.ts',
    ]);
  });

  it('unstage resets against HEAD when present, rm --cached when unborn', () => {
    expect(gitUnstageArgv('/r', ['a.ts'], true)).toEqual([
      'git',
      '-C',
      '/r',
      'reset',
      '-q',
      '--',
      'a.ts',
    ]);
    expect(gitUnstageArgv('/r', ['a.ts'], false)).toEqual([
      'git',
      '-C',
      '/r',
      'rm',
      '-r',
      '--cached',
      '-q',
      '--',
      'a.ts',
    ]);
  });

  it('commit injects the acting Flock user identity via -c', () => {
    expect(gitCommitArgv('/r', 'msg', IDENTITY)).toEqual([
      'git',
      '-C',
      '/r',
      '-c',
      'user.name=mike',
      '-c',
      'user.email=mike@flock.local',
      'commit',
      '-m',
      'msg',
    ]);
  });
});

describe('GitService.status', () => {
  it('runs git status in the working dir and returns the shared shape', async () => {
    const transport = new ScriptedTransport(() =>
      ok('# branch.head main\x001 .M N... 100644 100644 100644 h i src/x.ts\x00'),
    );
    const res = await buildService(transport).status(SESSION_ID);
    expect(transport.calls[0]).toEqual(gitStatusArgv(WORKING_DIR));
    expect(res.branch).toBe('main');
    expect(res.files).toHaveLength(1);
    expect(GitStatusResponse.safeParse(res).success).toBe(true);
  });

  it('throws GitOperationError when git fails (not a repo)', async () => {
    const transport = new ScriptedTransport(() => ok('', 'fatal: not a git repository', 128));
    await expect(buildService(transport).status(SESSION_ID)).rejects.toBeInstanceOf(
      GitOperationError,
    );
  });

  it('throws DiffSessionNotFoundError for an unknown session (→404)', async () => {
    await expect(buildService(null, null).status(SESSION_ID)).rejects.toBeInstanceOf(
      DiffSessionNotFoundError,
    );
  });

  it('throws GitOperationError when the node is unreachable', async () => {
    await expect(buildService(null).status(SESSION_ID)).rejects.toBeInstanceOf(GitOperationError);
  });
});

describe('GitService.stage / unstage', () => {
  it('stages then returns fresh status', async () => {
    const transport = new ScriptedTransport((cmd) =>
      cmd.includes('add') ? ok() : ok('# branch.head main\x00'),
    );
    const res = await buildService(transport).stage(SESSION_ID, ['a.ts']);
    expect(transport.calls[0]).toEqual(gitStageArgv(WORKING_DIR, ['a.ts']));
    expect(transport.calls[1]).toEqual(gitStatusArgv(WORKING_DIR)); // fresh status
    expect(res.branch).toBe('main');
  });

  it('probes HEAD then resets to unstage when a HEAD exists', async () => {
    const transport = new ScriptedTransport((cmd) => {
      if (cmd.includes('rev-parse')) return ok('abc'); // HEAD exists
      return ok('# branch.head main\x00');
    });
    await buildService(transport).unstage(SESSION_ID, ['a.ts']);
    expect(transport.calls[0]).toContain('rev-parse');
    expect(transport.calls[1]).toEqual(gitUnstageArgv(WORKING_DIR, ['a.ts'], true));
  });

  it('uses rm --cached to unstage on an unborn branch (no HEAD)', async () => {
    const transport = new ScriptedTransport((cmd) => {
      if (cmd.includes('rev-parse')) return ok('', '', 1); // no HEAD
      return ok('# branch.head main\x00');
    });
    await buildService(transport).unstage(SESSION_ID, []);
    expect(transport.calls[1]).toEqual(gitUnstageArgv(WORKING_DIR, [], false));
  });
});

describe('GitService.commit', () => {
  it('commits and reports the short sha', async () => {
    const transport = new ScriptedTransport((cmd) => {
      if (cmd.includes('commit')) return ok('[main abc123] msg\n 1 file changed');
      if (cmd.includes('rev-parse')) return ok('abc123\n');
      return ok();
    });
    const res = await buildService(transport).commit(SESSION_ID, 'msg', IDENTITY);
    expect(transport.calls[0]).toEqual(gitCommitArgv(WORKING_DIR, 'msg', IDENTITY));
    expect(res).toMatchObject({ committed: true, sha: 'abc123' });
  });

  it('returns committed=false (soft no-op) when nothing is staged', async () => {
    const transport = new ScriptedTransport(() =>
      ok('nothing to commit, working tree clean', '', 1),
    );
    const res = await buildService(transport).commit(SESSION_ID, 'msg', IDENTITY);
    expect(res).toMatchObject({ committed: false, sha: null });
  });

  it('throws GitOperationError on a real commit failure', async () => {
    const transport = new ScriptedTransport(() => ok('', 'fatal: bad thing', 128));
    await expect(buildService(transport).commit(SESSION_ID, 'msg', IDENTITY)).rejects.toBeInstanceOf(
      GitOperationError,
    );
  });
});

describe('GitService.push', () => {
  it('pushes and returns git output', async () => {
    const transport = new ScriptedTransport(() => ok('', 'Everything up-to-date'));
    const res = await buildService(transport).push(SESSION_ID);
    expect(transport.calls[0]).toEqual(['git', '-C', WORKING_DIR, 'push']);
    expect(res.pushed).toBe(true);
    expect(res.detail).toContain('up-to-date');
  });

  it('falls back to --set-upstream when there is no upstream', async () => {
    const transport = new ScriptedTransport((cmd) => {
      if (cmd.includes('-u')) return ok('', 'Branch set up to track');
      return ok('', 'fatal: The current branch has no upstream branch', 128);
    });
    const res = await buildService(transport).push(SESSION_ID);
    expect(transport.calls[1]).toEqual(['git', '-C', WORKING_DIR, 'push', '-u', 'origin', 'HEAD']);
    expect(res.pushed).toBe(true);
  });

  it('throws GitOperationError with git output on a rejected push', async () => {
    const transport = new ScriptedTransport(() => ok('', 'error: failed to push (non-fast-forward)', 1));
    await expect(buildService(transport).push(SESSION_ID)).rejects.toThrow(/non-fast-forward/);
  });
});
