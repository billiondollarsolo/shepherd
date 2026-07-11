import { describe, expect, it } from 'vitest';

import { NodeWorkspaceService, searchArgv, stackArgv } from './node-workspace-service.js';
import type { ExecResult, NodeTransport } from './transport/transport.js';

function fakeTransport(out: string, exitCode = 0): NodeTransport {
  return {
    kind: 'local',
    async exec(): Promise<ExecResult> {
      return { exitCode, signal: null, stdout: out, stderr: '', timedOut: false };
    },
    async openPty() {
      throw new Error('nope');
    },
    async dispose() {},
  } as unknown as NodeTransport;
}

const svc = (out: string, code = 0) =>
  new NodeWorkspaceService({
    transports: { transportForNode: async () => fakeTransport(out, code) },
  });

describe('workspace argv (the contract)', () => {
  it('stackArgv passes the path positionally', () => {
    expect(stackArgv('/x/y')).toEqual(['sh', '-c', expect.any(String), 'flock-ws', '/x/y']);
  });
  it('searchArgv encodes case/word/regex flags + positional query', () => {
    const a = searchArgv('/x', 'foo(', { caseSensitive: true, regex: true });
    // dir, query, ignoreCase(0 because caseSensitive), word(0), regex(1)
    expect(a.slice(-5)).toEqual(['/x', 'foo(', '0', '0', '1']);
    const b = searchArgv('/x', 'foo', {});
    expect(b.slice(-5)).toEqual(['/x', 'foo', '1', '0', '0']); // default: case-insensitive, literal
  });
});

describe('detectStack', () => {
  it('parses the abs path + unique stack ids (non-git dir → gitRepo false)', async () => {
    const r = await svc('/home/flock/repo\nnode\ndocker\nnode\n').detectStack(
      'n',
      '/home/flock/repo',
    );
    expect(r.path).toBe('/home/flock/repo');
    expect(r.stacks).toEqual(['node', 'docker']);
    expect(r.gitRepo).toBe(false);
  });

  it('reports gitRepo true on the __git__ marker and strips it from stacks', async () => {
    const r = await svc('/home/flock/repo\n__git__\nnode\n').detectStack('n', '/home/flock/repo');
    expect(r.gitRepo).toBe(true);
    expect(r.gitHasCommits).toBe(false); // no __git_commits__ → unborn HEAD
    expect(r.stacks).toEqual(['node']);
  });

  it('reports gitHasCommits true on __git_commits__ (repo with a commit) and strips both markers', async () => {
    const r = await svc('/home/flock/repo\n__git__\n__git_commits__\nnode\n').detectStack(
      'n',
      '/home/flock/repo',
    );
    expect(r.gitRepo).toBe(true);
    expect(r.gitHasCommits).toBe(true);
    expect(r.stacks).toEqual(['node']);
  });
});

describe('listFiles', () => {
  it('returns trimmed non-empty lines', async () => {
    const r = await svc('src/a.ts\nsrc/b.ts\n\n').listFiles('n', '/x');
    expect(r).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('search', () => {
  it('parses path:line:text matches', async () => {
    const out = 'src/a.ts:12:const x = 1\n./src/b.ts:3:foo bar\nnomatchline\n';
    const r = await svc(out).search('n', '/x', 'foo');
    expect(r.matches).toEqual([
      { file: 'src/a.ts', line: 12, text: 'const x = 1' },
      { file: 'src/b.ts', line: 3, text: 'foo bar' },
    ]);
    expect(r.truncated).toBe(false);
  });
  it('empty query short-circuits', async () => {
    const r = await svc('').search('n', '/x', '');
    expect(r.matches).toEqual([]);
  });
});
