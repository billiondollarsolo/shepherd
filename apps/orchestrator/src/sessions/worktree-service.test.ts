import { describe, expect, it } from 'vitest';

import { WorktreeService, sanitizeBranchSegment } from './worktree-service.js';
import type { ExecResult, NodeTransport } from '../nodes/transport/transport.js';

/** A fake transport that records argv and returns scripted results per matcher. */
function fakeTransport(
  handler: (argv: string[]) => Partial<ExecResult>,
  log: string[][],
): NodeTransport {
  return {
    kind: 'local',
    async exec(argv: string[]): Promise<ExecResult> {
      log.push(argv);
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...handler(argv) };
    },
    async openPty() {
      throw new Error('not used');
    },
    async dispose() {},
  } as unknown as NodeTransport;
}

describe('sanitizeBranchSegment', () => {
  it('keeps valid git ref chars, replaces the rest', () => {
    expect(sanitizeBranchSegment('flock/abc123')).toBe('flock/abc123');
    expect(sanitizeBranchSegment('my feature!')).toBe('my-feature');
    expect(sanitizeBranchSegment('  .weird..name. ')).toBe('weird-name');
    expect(sanitizeBranchSegment('')).toBe('session');
  });
});

describe('WorktreeService.create', () => {
  it('runs `git worktree add --no-track -b` off HEAD in a sibling dir', async () => {
    const log: string[][] = [];
    const t = fakeTransport((argv) => {
      if (argv.includes('--show-toplevel')) return { stdout: '/home/flock/repo\n' };
      return {};
    }, log);
    const svc = new WorktreeService({ transports: async () => t });
    const wt = await svc.create('n1', '/home/flock/repo', 'flock/abcd1234');
    expect(wt.branch).toBe('flock/abcd1234');
    expect(wt.path).toBe('/home/flock/.flock-worktrees/repo/flock-abcd1234');
    const add = log.find((a) => a.includes('add'));
    expect(add).toEqual([
      'git', '-C', '/home/flock/repo', 'worktree', 'add', '--no-track', '-b',
      'flock/abcd1234', '/home/flock/.flock-worktrees/repo/flock-abcd1234', 'HEAD',
    ]);
  });

  it('throws when the dir is not a git repo', async () => {
    const t = fakeTransport((argv) => {
      if (argv.includes('--show-toplevel')) return { exitCode: 128, stderr: 'not a git repo' };
      return {};
    }, []);
    const svc = new WorktreeService({ transports: async () => t });
    await expect(svc.create('n1', '/tmp/plain', 'flock/x')).rejects.toThrow(/not a git repository/i);
  });
});

describe('WorktreeService.remove', () => {
  it('removes the worktree and deletes a merged branch', async () => {
    const log: string[][] = [];
    const t = fakeTransport((argv) => {
      if (argv.includes('list')) return { stdout: 'worktree /home/flock/repo\nHEAD abc\n' };
      return {}; // branch -d succeeds (exitCode 0) → merged, deleted cleanly
    }, log);
    const svc = new WorktreeService({ transports: async () => t });
    await svc.remove('n1', '/home/flock/.flock-worktrees/repo/x', 'flock/x');
    expect(log.some((a) => a.includes('remove') && a.includes('--force'))).toBe(true);
    expect(log.some((a) => a.includes('prune'))).toBe(true);
    expect(log.some((a) => a[3] === 'branch' && a.includes('-d'))).toBe(true);
  });

  it('PRESERVES an unmerged branch (no force delete)', async () => {
    const log: string[][] = [];
    const t = fakeTransport((argv) => {
      if (argv.includes('list')) return { stdout: 'worktree /home/flock/repo\n' };
      if (argv.includes('-d')) return { exitCode: 1, stderr: 'not fully merged' };
      if (argv.includes('--is-ancestor')) return { exitCode: 1 }; // NOT merged
      return {};
    }, log);
    const svc = new WorktreeService({ transports: async () => t });
    await svc.remove('n1', '/home/flock/.flock-worktrees/repo/x', 'flock/x');
    expect(log.some((a) => a.includes('-D'))).toBe(false); // never force-deleted
  });
});
