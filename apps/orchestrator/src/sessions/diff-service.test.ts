/**
 * US-33 — DiffService unit tests (run under `pnpm test:unit`).
 *
 * The service produces the read-only `git diff` of a session's working dir for
 * the center Diff tab (FR-UI4). These tests pin down:
 *   - the exact argv handed to the node (the node is a dumb courier; argv IS the
 *     contract) and that it runs in the session working dir;
 *   - a clean tree yields an EMPTY diff (not an error);
 *   - a dirty tree yields the git diff text in the shared DiffResponse shape;
 *   - an unknown session → SessionNotFoundError (route maps → 404);
 *   - git failure (non-git dir / nonzero exit / timeout) → DiffUnavailableError.
 *
 * No real git/tmux/Postgres: a fake lookup + fake transport make this a pure
 * orchestration unit test.
 */
import { describe, expect, it } from 'vitest';

import { DiffResponse } from '@flock/shared';

import type { ExecOptions, ExecResult, NodeTransport } from '../nodes/transport/transport.js';
import {
  DiffService,
  DiffSessionNotFoundError,
  DiffUnavailableError,
  GIT_EMPTY_TREE,
  gitDiffArgv,
  gitHasHeadArgv,
  type DiffSessionInfo,
} from './diff-service.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const WORKING_DIR = '/work/repo';

function sessionInfo(overrides: Partial<DiffSessionInfo> = {}): DiffSessionInfo {
  return { id: SESSION_ID, nodeId: NODE_ID, workingDir: WORKING_DIR, ...overrides };
}

/** Records exec calls and returns a scripted result (or throws). */
class FakeTransport implements NodeTransport {
  readonly kind = 'local' as const;
  readonly calls: Array<{ command: string[]; options?: ExecOptions }> = [];

  constructor(
    private readonly outcome:
      | { type: 'result'; result: ExecResult }
      | { type: 'throw'; error: Error },
  ) {}

  async exec(command: string[], options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    if (this.outcome.type === 'throw') throw this.outcome.error;
    return this.outcome.result;
  }
  async openPty(): Promise<never> {
    throw new Error('not used in diff tests');
  }
  async dispose(): Promise<void> {}
}

function execOk(stdout: string): ExecResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false };
}

function buildService(opts: {
  session?: DiffSessionInfo | null;
  transport?: NodeTransport | null;
  timeoutMs?: number;
}): DiffService {
  const session = opts.session === undefined ? sessionInfo() : opts.session;
  return new DiffService({
    sessions: { getSession: async () => session },
    transports: { transportForNode: () => opts.transport ?? null },
    options: opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined,
  });
}

describe('gitDiffArgv', () => {
  it('produces a read-only, plain-text, working-dir-scoped diff command', () => {
    expect(gitDiffArgv('/srv/app')).toEqual([
      'git',
      '-C',
      '/srv/app',
      '--no-pager',
      'diff',
      '--no-color',
      'HEAD',
    ]);
  });
});

describe('DiffService.getDiff (US-33)', () => {
  it('runs git diff in the session working dir and returns the shared DiffResponse', async () => {
    const diffText =
      'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const transport = new FakeTransport({ type: 'result', result: execOk(diffText) });
    const service = buildService({ transport });

    const res = await service.getDiff(SESSION_ID);

    // exact argv + working dir (dumb courier contract): a HEAD probe, then the
    // diff against HEAD (the probe here resolves, so base stays HEAD).
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]!.command).toEqual(gitHasHeadArgv(WORKING_DIR));
    expect(transport.calls[1]!.command).toEqual(gitDiffArgv(WORKING_DIR));
    expect(transport.calls[1]!.options?.cwd).toBe(WORKING_DIR);

    expect(res.sessionId).toBe(SESSION_ID);
    expect(res.diff).toBe(diffText);
    // conforms to the shared contract (never duplicated)
    expect(DiffResponse.safeParse(res).success).toBe(true);
  });

  it('diffs against the empty tree when the repo has no commits (no HEAD)', async () => {
    // A fresh `git init` has no HEAD → the rev-parse probe fails → diff vs empty
    // tree (so `git diff HEAD` never fatals with "ambiguous argument 'HEAD'").
    const calls: string[][] = [];
    const transport: NodeTransport = {
      kind: 'local',
      async exec(command) {
        calls.push(command);
        if (command.includes('rev-parse')) {
          return { exitCode: 1, signal: null, stdout: '', stderr: '', timedOut: false };
        }
        return { exitCode: 0, signal: null, stdout: 'diff…', stderr: '', timedOut: false };
      },
      async openPty() {
        throw new Error('unused');
      },
      async dispose() {},
    };
    const service = buildService({ transport });

    const res = await service.getDiff(SESSION_ID);

    expect(calls[0]).toEqual(gitHasHeadArgv(WORKING_DIR));
    expect(calls[1]).toEqual(gitDiffArgv(WORKING_DIR, GIT_EMPTY_TREE));
    expect(res.diff).toBe('diff…');
  });

  it('returns an EMPTY diff (not an error) for a clean tree', async () => {
    const transport = new FakeTransport({ type: 'result', result: execOk('') });
    const service = buildService({ transport });

    const res = await service.getDiff(SESSION_ID);

    expect(res.diff).toBe('');
    expect(DiffResponse.safeParse(res).success).toBe(true);
  });

  it('throws DiffSessionNotFoundError for an unknown session (route → 404)', async () => {
    const service = buildService({ session: null });
    await expect(service.getDiff(SESSION_ID)).rejects.toBeInstanceOf(
      DiffSessionNotFoundError,
    );
  });

  it('throws DiffUnavailableError when the node has no live transport', async () => {
    const service = buildService({ transport: null });
    await expect(service.getDiff(SESSION_ID)).rejects.toBeInstanceOf(DiffUnavailableError);
  });

  it('throws DiffUnavailableError when git exits non-zero (e.g. not a git repo)', async () => {
    const transport = new FakeTransport({
      type: 'result',
      result: {
        exitCode: 128,
        signal: null,
        stdout: '',
        stderr: 'fatal: not a git repository',
        timedOut: false,
      },
    });
    const service = buildService({ transport });

    await expect(service.getDiff(SESSION_ID)).rejects.toMatchObject({
      name: 'DiffUnavailableError',
      detail: expect.stringContaining('not a git repository'),
    });
  });

  it('throws DiffUnavailableError when git diff times out', async () => {
    const transport = new FakeTransport({
      type: 'result',
      result: { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true },
    });
    const service = buildService({ transport });

    await expect(service.getDiff(SESSION_ID)).rejects.toBeInstanceOf(DiffUnavailableError);
  });

  it('wraps a transport exec rejection in DiffUnavailableError', async () => {
    const transport = new FakeTransport({ type: 'throw', error: new Error('boom') });
    const service = buildService({ transport });

    await expect(service.getDiff(SESSION_ID)).rejects.toBeInstanceOf(DiffUnavailableError);
  });
});
