/**
 * Roadmap P5 — branch ops + PR creation unit tests. A scripted fake transport
 * returns per-command results so each git/gh argv is asserted in isolation
 * (no real git/gh/network), mirroring git-service.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { ExecOptions, ExecResult, NodeTransport } from '../nodes/transport/transport.js';
import type { DiffSessionInfo } from './diff-service.js';
import {
  GitOperationError,
  GitService,
  extractPrUrl,
  firstOpenPrUrl,
  ghErrorHint,
  ghPrCreateArgv,
  ghPrListArgv,
  gitCreateBranchArgv,
  gitListBranchesArgv,
  gitSwitchBranchArgv,
} from './git-service.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const WORKING_DIR = '/work/repo';

function ok(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false };
}

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

function buildService(transport: NodeTransport, session: DiffSessionInfo = { id: SESSION_ID, nodeId: NODE_ID, workingDir: WORKING_DIR }) {
  return new GitService({
    sessions: { getSession: async () => session },
    transports: { transportForNode: () => transport },
  });
}

/** Porcelain-v2 status output on branch `name`. */
function statusOn(name: string): string {
  return `# branch.oid abc123\0# branch.head ${name}\0`;
}

describe('argv builders (P5)', () => {
  it('gitCreateBranchArgv with and without a start point', () => {
    expect(gitCreateBranchArgv(WORKING_DIR, 'feat/x')).toEqual(['git', '-C', WORKING_DIR, 'switch', '-c', 'feat/x']);
    expect(gitCreateBranchArgv(WORKING_DIR, 'feat/x', 'main')).toEqual(['git', '-C', WORKING_DIR, 'switch', '-c', 'feat/x', 'main']);
  });
  it('gitSwitchBranchArgv / gitListBranchesArgv', () => {
    expect(gitSwitchBranchArgv(WORKING_DIR, 'main')).toEqual(['git', '-C', WORKING_DIR, 'switch', 'main']);
    expect(gitListBranchesArgv(WORKING_DIR)).toContain('--format=%(refname:short)');
  });
  it('ghPrListArgv targets the head branch + open state', () => {
    expect(ghPrListArgv('feat/x')).toEqual(['gh', 'pr', 'list', '--head', 'feat/x', '--state', 'open', '--limit', '1', '--json', 'url,number,title']);
  });
  it('ghPrCreateArgv includes base + draft when given', () => {
    expect(ghPrCreateArgv({ title: 'T', body: 'B' })).toEqual(['gh', 'pr', 'create', '--title', 'T', '--body', 'B']);
    expect(ghPrCreateArgv({ title: 'T', base: 'main', draft: true })).toEqual(['gh', 'pr', 'create', '--title', 'T', '--body', '', '--base', 'main', '--draft']);
  });
});

describe('gh output helpers (P5)', () => {
  it('extractPrUrl picks the last URL line', () => {
    expect(extractPrUrl('Warning: ...\nhttps://github.com/o/r/pull/42\n')).toBe('https://github.com/o/r/pull/42');
    expect(extractPrUrl('no url here')).toBeNull();
  });
  it('firstOpenPrUrl parses the gh json list', () => {
    expect(firstOpenPrUrl('[{"url":"https://github.com/o/r/pull/7","number":7}]')).toBe('https://github.com/o/r/pull/7');
    expect(firstOpenPrUrl('[]')).toBeNull();
    expect(firstOpenPrUrl('not json')).toBeNull();
  });
  it('ghErrorHint friendlies the missing/unauthed cases', () => {
    expect(ghErrorHint('bash: gh: command not found')).toMatch(/not found on PATH/);
    expect(ghErrorHint('gh auth login required')).toMatch(/not authenticated/);
    expect(ghErrorHint('some other error')).toBe('some other error');
  });
});

describe('GitService.createBranch / switchBranch (P5)', () => {
  it('createBranch runs switch -c and reports created', async () => {
    const t = new ScriptedTransport(() => ok());
    const res = await buildService(t).createBranch(SESSION_ID, 'feat/x', 'main');
    expect(t.calls[0]).toEqual(['git', '-C', WORKING_DIR, 'switch', '-c', 'feat/x', 'main']);
    expect(res).toMatchObject({ branch: 'feat/x', created: true });
  });
  it('switchBranch runs switch and reports not-created', async () => {
    const t = new ScriptedTransport(() => ok());
    const res = await buildService(t).switchBranch(SESSION_ID, 'main');
    expect(t.calls[0]).toEqual(['git', '-C', WORKING_DIR, 'switch', 'main']);
    expect(res).toMatchObject({ branch: 'main', created: false });
  });
});

describe('GitService.createPr (P5)', () => {
  it('returns an existing open PR without creating a new one (idempotent)', async () => {
    const t = new ScriptedTransport((cmd) => {
      if (cmd.includes('status')) return ok(statusOn('feat/x'));
      if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
        return ok('[{"url":"https://github.com/o/r/pull/9","number":9}]');
      }
      return ok(); // pr create should NOT be reached
    });
    const res = await buildService(t).createPr(SESSION_ID, { title: 'T' });
    expect(res).toMatchObject({ created: false, url: 'https://github.com/o/r/pull/9' });
    expect(t.calls.some((c) => c[2] === 'create')).toBe(false);
  });

  it('creates a PR and returns its URL when none exists', async () => {
    const t = new ScriptedTransport((cmd) => {
      if (cmd.includes('status')) return ok(statusOn('feat/x'));
      if (cmd[2] === 'list') return ok('[]');
      if (cmd[2] === 'create') return ok('https://github.com/o/r/pull/10\n');
      return ok();
    });
    const res = await buildService(t).createPr(SESSION_ID, { title: 'T', body: 'B' });
    expect(res).toMatchObject({ created: true, url: 'https://github.com/o/r/pull/10' });
    expect(t.calls.some((c) => c[2] === 'create')).toBe(true);
  });

  it('throws a friendly error when gh is missing', async () => {
    const t = new ScriptedTransport((cmd) => {
      if (cmd.includes('status')) return ok(statusOn('feat/x'));
      if (cmd[2] === 'list') return ok('[]');
      if (cmd[2] === 'create') return ok('', 'bash: gh: command not found', 127);
      return ok();
    });
    await expect(buildService(t).createPr(SESSION_ID, { title: 'T' })).rejects.toBeInstanceOf(GitOperationError);
  });

  it('refuses on a detached HEAD', async () => {
    const t = new ScriptedTransport((cmd) => {
      if (cmd.includes('status')) return ok('# branch.oid abc\0# branch.head (detached)\0');
      return ok();
    });
    await expect(buildService(t).createPr(SESSION_ID, { title: 'T' })).rejects.toThrow(/detached/i);
  });
});
