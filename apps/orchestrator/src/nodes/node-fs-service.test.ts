import { describe, it, expect } from 'vitest';

import {
  FS_LIST_SCRIPT,
  FS_MKDIR_SCRIPT,
  FS_WRITE_CAP_BYTES,
  NodeFsService,
  NodePathError,
  NodeUnreachableError,
  fsListArgv,
  fsMkdirArgv,
  fsReadArgv,
  fsWriteArgv,
} from './node-fs-service.js';
import type { ExecOptions, ExecResult, NodeTransport } from './transport/transport.js';

/** A transport stub that returns a scripted exec result and records the argv. */
function fakeTransport(result: Partial<ExecResult>): {
  transport: NodeTransport;
  calls: { command: string[]; options?: ExecOptions }[];
} {
  const calls: { command: string[]; options?: ExecOptions }[] = [];
  const transport: NodeTransport = {
    kind: 'ssh',
    async exec(command, options) {
      calls.push({ command, options });
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...result,
      };
    },
    async openPty() {
      throw new Error('not used');
    },
    async dispose() {},
  };
  return { transport, calls };
}

const NODE = 'node-1';

describe('fsListArgv', () => {
  it('passes the path positionally (not interpolated) to sh -c', () => {
    const argv = fsListArgv('/home/flock/proj');
    expect(argv[0]).toBe('sh');
    expect(argv[1]).toBe('-c');
    expect(argv[2]).toBe(FS_LIST_SCRIPT);
    expect(argv[3]).toBe('flock-fs'); // $0
    expect(argv[4]).toBe('/home/flock/proj'); // $1 — safe from injection
  });

  it('sends an empty positional when no path is given (script defaults to $HOME)', () => {
    expect(fsListArgv(undefined)[4]).toBe('');
  });
});

describe('fsMkdirArgv', () => {
  it('passes parent + name positionally (injection-safe)', () => {
    const argv = fsMkdirArgv('/home/flock/proj', 'newdir');
    expect(argv).toEqual(['sh', '-c', FS_MKDIR_SCRIPT, 'flock-fs', '/home/flock/proj', 'newdir']);
  });
});

describe('NodeFsService.makeDir', () => {
  it('creates the dir and returns its resolved absolute path', async () => {
    const { transport, calls } = fakeTransport({ stdout: '/home/flock/proj/newdir\n' });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    const res = await svc.makeDir(NODE, '/home/flock/proj', 'newdir');
    expect(res).toEqual({ path: '/home/flock/proj/newdir' });
    expect(calls[0]?.command[4]).toBe('/home/flock/proj'); // parent → $1
    expect(calls[0]?.command[5]).toBe('newdir'); // name → $2
  });

  it('rejects a name that is not a single path component (no transport call)', async () => {
    const { transport, calls } = fakeTransport({ stdout: '' });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    for (const bad of ['a/b', '..', '.', '', '   ']) {
      await expect(svc.makeDir(NODE, '/p', bad)).rejects.toBeInstanceOf(NodePathError);
    }
    expect(calls).toHaveLength(0); // never reached the node
  });

  it('maps the error sentinel (exists / no perms) to NodePathError', async () => {
    const { transport } = fakeTransport({ stdout: '__FLOCK_FS_ERR__\n', exitCode: 1 });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    await expect(svc.makeDir(NODE, '/p', 'dup')).rejects.toBeInstanceOf(NodePathError);
  });

  it('throws NodeUnreachableError when the node has no transport', async () => {
    const svc = new NodeFsService({ transports: { transportForNode: async () => null } });
    await expect(svc.makeDir(NODE, '/p', 'x')).rejects.toBeInstanceOf(NodeUnreachableError);
  });
});

describe('NodeFsService.listDir', () => {
  it('parses pwd + directory names into sorted entries with absolute paths', async () => {
    const { transport, calls } = fakeTransport({
      stdout: '/home/flock\nzeta\nalpha\nmnt\n',
    });
    const svc = new NodeFsService({
      transports: { transportForNode: async () => transport },
    });

    const res = await svc.listDir(NODE, '/home/flock');

    expect(res.path).toBe('/home/flock');
    expect(res.parent).toBe('/home');
    expect(res.entries).toEqual([
      { name: 'alpha', path: '/home/flock/alpha' },
      { name: 'mnt', path: '/home/flock/mnt' },
      { name: 'zeta', path: '/home/flock/zeta' },
    ]);
    // The path was forwarded as the positional arg.
    expect(calls[0]?.command[4]).toBe('/home/flock');
  });

  it('reports null parent at the filesystem root', async () => {
    const { transport } = fakeTransport({ stdout: '/\nbin\netc\n' });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    const res = await svc.listDir(NODE, '/');
    expect(res.path).toBe('/');
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.path)).toEqual(['/bin', '/etc']);
  });

  it('handles an empty directory (pwd only, no children)', async () => {
    const { transport } = fakeTransport({ stdout: '/home/flock/empty\n' });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    const res = await svc.listDir(NODE, '/home/flock/empty');
    expect(res.entries).toEqual([]);
    expect(res.parent).toBe('/home/flock');
  });

  it('throws NodeUnreachableError when the node has no transport', async () => {
    const svc = new NodeFsService({ transports: { transportForNode: async () => null } });
    await expect(svc.listDir(NODE)).rejects.toBeInstanceOf(NodeUnreachableError);
  });

  it('throws NodePathError on the error sentinel / non-zero exit', async () => {
    const { transport } = fakeTransport({ stdout: '__FLOCK_FS_ERR__\n', exitCode: 1 });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    await expect(svc.listDir(NODE, '/nope')).rejects.toBeInstanceOf(NodePathError);
  });

  it('throws NodePathError when the listing times out', async () => {
    const { transport } = fakeTransport({ timedOut: true, stdout: '' });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    await expect(svc.listDir(NODE)).rejects.toBeInstanceOf(NodePathError);
  });
});

describe('NodeFsService.listTree (dirs + files)', () => {
  it('tags kind from the trailing slash, sorts dirs before files', async () => {
    const { transport } = fakeTransport({ stdout: '/home/flock\nsrc/\nREADME.md\n.env\nlib/\n' });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    const res = await svc.listTree(NODE, '/home/flock');
    expect(res.entries).toEqual([
      { name: 'lib', path: '/home/flock/lib', kind: 'dir' },
      { name: 'src', path: '/home/flock/src', kind: 'dir' },
      { name: '.env', path: '/home/flock/.env', kind: 'file' },
      { name: 'README.md', path: '/home/flock/README.md', kind: 'file' },
    ]);
  });
});

describe('NodeFsService.readFile', () => {
  it('parses size + base64 body and forwards the path positionally', async () => {
    const b64 = Buffer.from('hello world').toString('base64');
    const { transport, calls } = fakeTransport({ stdout: `11\n${b64}\n` });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    const res = await svc.readFile(NODE, '/home/flock/a.txt');
    expect(res.size).toBe(11);
    expect(res.truncated).toBe(false);
    expect(Buffer.from(res.contentBase64, 'base64').toString()).toBe('hello world');
    expect(calls[0]?.command).toEqual(fsReadArgv('/home/flock/a.txt', 2_000_000));
  });

  it('throws NodePathError on the error sentinel (not a file)', async () => {
    const { transport } = fakeTransport({ stdout: '__FLOCK_FS_ERR__\n', exitCode: 1 });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    await expect(svc.readFile(NODE, '/dir')).rejects.toBeInstanceOf(NodePathError);
  });
});

describe('NodeFsService.writeFile', () => {
  it('pipes the base64 to the write argv as stdin', async () => {
    const { transport, calls } = fakeTransport({ stdout: '', exitCode: 0 });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    const b64 = Buffer.from('new content').toString('base64');
    await svc.writeFile(NODE, '/home/flock/a.txt', b64);
    expect(calls[0]?.command).toEqual(fsWriteArgv('/home/flock/a.txt'));
    expect(calls[0]?.options?.input).toBe(b64);
  });

  it('rejects a write over the size cap before touching the transport', async () => {
    let called = false;
    const svc = new NodeFsService({
      transports: {
        transportForNode: async () => {
          called = true;
          return null;
        },
      },
    });
    const huge = 'A'.repeat(Math.ceil((FS_WRITE_CAP_BYTES + 10) * 4) / 3);
    await expect(svc.writeFile(NODE, '/x', huge)).rejects.toBeInstanceOf(NodePathError);
    expect(called).toBe(false); // cap checked before resolving a transport
  });

  it('throws NodePathError when the parent dir is missing (sentinel)', async () => {
    const { transport } = fakeTransport({ stdout: '__FLOCK_FS_ERR__', exitCode: 1 });
    const svc = new NodeFsService({ transports: { transportForNode: async () => transport } });
    await expect(svc.writeFile(NODE, '/nope/x', 'AAAA')).rejects.toBeInstanceOf(NodePathError);
  });
});
