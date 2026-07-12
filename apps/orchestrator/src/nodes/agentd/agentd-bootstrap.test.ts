import { readFile } from 'node:fs/promises';
import { PassThrough, type Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  AgentdBootstrap,
  type AgentdBinaryProvider,
  type AgentdPlatform,
} from './agentd-bootstrap.js';
import type { AgentdExecResult, AgentdHost } from './ssh-agentd-host.js';

interface ExecRule {
  match: RegExp;
  result: Partial<AgentdExecResult>;
}

class FakeHost implements AgentdHost {
  execs: string[] = [];
  uploads: Array<{ local: string; remote: string; mode?: number; content?: string }> = [];
  listening = false;

  constructor(private readonly rules: ExecRule[]) {}

  async exec(command: string): Promise<AgentdExecResult> {
    this.execs.push(command);
    for (const rule of this.rules) {
      if (rule.match.test(command)) {
        return { code: 0, stdout: '', stderr: '', ...rule.result };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async uploadFile(local: string, remote: string, mode?: number): Promise<void> {
    let content: string | undefined;
    if (local.includes('flock-agentd-credential-')) {
      content = await readFile(local, 'utf8');
    }
    this.uploads.push({ local, remote, mode, content });
  }

  async forwardOut(): Promise<Duplex> {
    if (!this.listening) throw new Error('connection refused');
    return new PassThrough();
  }
}

const TEST_BINARY = fileURLToPath(new URL('../../../../../agentd/VERSION', import.meta.url));
const resolveBinary = vi.fn(async (_platform: AgentdPlatform) => TEST_BINARY);
const binaries: AgentdBinaryProvider = { resolve: resolveBinary };
const SECRET = 'node-specific-control-secret-at-least-32-bytes';
const IDENTITY = { nodeId: 'node-test-1234', credential: SECRET };

function make(version = '1.2.3') {
  return new AgentdBootstrap({ version, port: 48222, binaries });
}

describe('AgentdBootstrap secure system service', () => {
  it('requires a strong per-node credential', async () => {
    await expect(
      make().ensureRunning(new FakeHost([]), {
        nodeId: IDENTITY.nodeId,
        credential: 'short',
      }),
    ).rejects.toThrow(/per-node credential/);
  });

  it('reasserts a stopped matching installation without uploading the binary', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.2.3\n' },
      },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
    ]);
    await expect(make().ensureRunning(host, IDENTITY)).resolves.toEqual({
      host: '127.0.0.1',
      port: 48222,
    });
    expect(host.execs.some((command) => command.includes('uname'))).toBe(false);
    expect(host.uploads.filter((upload) => upload.mode === 0o700)).toHaveLength(0);
    expect(host.uploads.filter((upload) => upload.mode === 0o600)).toHaveLength(1);
    expect(host.execs.some((command) => command.includes('install-service'))).toBe(true);
    expect(host.execs.some((command) => command.includes('flock-node-admin restart'))).toBe(true);
  });

  it('leaves a healthy matching daemon and live sessions untouched', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.2.3\n' },
      },
    ]);
    host.listening = true;
    await make().ensureRunning(host, IDENTITY);
    expect(host.uploads).toHaveLength(0);
    expect(host.execs.some((command) => command.includes('systemctl'))).toBe(false);
  });

  it('migrates an unmanaged service without replacing a matching binary', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.2.3\n' },
      },
      { match: /service-status/, result: { code: 1 } },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
    ]);
    host.listening = true;
    await make().ensureRunning(host, IDENTITY);
    expect(host.uploads.filter((upload) => upload.mode === 0o700)).toHaveLength(0);
    expect(host.execs).toContain(
      "sudo -n /usr/local/sbin/flock-node-admin install-service 'node-test-1234' 48222\n" +
        'sudo -n /usr/local/sbin/flock-node-admin restart service',
    );
  });

  it('verifies and atomically installs the architecture-matched binary', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '0.0.1\n' },
      },
      { match: /uname/, result: { stdout: 'Linux\nx86_64\n' } },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
    ]);
    await make().ensureRunning(host, IDENTITY);
    const binary = host.uploads.find((upload) => upload.mode === 0o700);
    expect(binary).toMatchObject({
      local: TEST_BINARY,
      remote: '/home/admin/.flock-agentd-binary.new',
    });
    expect(resolveBinary).toHaveBeenCalledWith({ os: 'linux', arch: 'amd64' });
    const install = host.execs.find((command) => command.includes('install-binary'));
    expect(install).toContain('sudo -n /usr/local/sbin/flock-node-admin install-binary');
    expect(install).toMatch(/[a-f0-9]{64}/);
  });

  it('emits stable install lifecycle events without credential material', async () => {
    const events: string[] = [];
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '' },
      },
      { match: /uname/, result: { stdout: 'Linux\nx86_64\n' } },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
    ]);
    const bootstrap = new AgentdBootstrap({
      version: '1.2.3',
      port: 48222,
      binaries,
      onEvent: (_nodeId, event) => events.push(event),
    });

    await bootstrap.ensureRunning(host, IDENTITY);

    expect(events).toEqual(['installed', 'service_started']);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('uploads the credential as protected file content, never shell text', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.2.3\n' },
      },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
    ]);
    await make().ensureRunning(host, IDENTITY);
    const credential = host.uploads.find((upload) => upload.mode === 0o600);
    expect(credential?.remote).toBe('/home/admin/.flock-agentd-control.new');
    expect(credential?.content).toBe(`${SECRET}\n`);
    expect(host.execs.join('\n')).not.toContain(SECRET);
    expect(host.execs.join('\n')).toContain('flock-node-admin install-credential');
  });

  it('installs a root service that drops agents to a non-admin runtime user', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.2.3\n' },
      },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
    ]);
    await make().ensureRunning(host, IDENTITY);
    const service = host.execs.find((command) => command.includes('install-service'))!;
    expect(service).toContain('flock-node-admin install-service');
    expect(service).not.toContain('systemctl --user');
    expect(service).not.toContain('nohup');
    expect(service).toContain("install-service 'node-test-1234' 48222");
  });

  it('rejects unsupported platforms', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: 'old\n' },
      },
      { match: /uname/, result: { stdout: 'Linux\nmips\n' } },
    ]);
    await expect(make().ensureRunning(host, IDENTITY)).rejects.toThrow(/unsupported node platform/);
  });

  it('fails closed when checksum verification or enrollment fails', async () => {
    const checksumHost = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: 'old\n' },
      },
      { match: /uname/, result: { stdout: 'Linux\nx86_64\n' } },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
      { match: /install-binary/, result: { code: 1, stderr: 'checksum mismatch' } },
    ]);
    await expect(make().ensureRunning(checksumHost, IDENTITY)).rejects.toThrow(
      /remote command failed/,
    );

    const serviceHost = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.2.3\n' },
      },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/admin' } },
      { match: /install-service/, result: { code: 1, stderr: 'sudo denied' } },
    ]);
    const warn = vi.fn();
    const bootstrap = new AgentdBootstrap({
      version: '1.2.3',
      port: 48222,
      binaries,
      logger: { warn },
    });
    await expect(bootstrap.ensureRunning(serviceHost, IDENTITY)).rejects.toThrow(
      /enrollment failed/,
    );
    expect(warn).toHaveBeenCalled();
  });

  it('reports rollout state without mutating the host', async () => {
    const host = new FakeHost([
      {
        match: /^\/usr\/local\/lib\/flock-agentd\/flock-agentd version/,
        result: { stdout: '1.0.0\n' },
      },
    ]);
    host.listening = true;
    await expect(make().inspect(host)).resolves.toEqual({
      installedVersion: '1.0.0',
      expectedVersion: '1.2.3',
      running: true,
      servicePrepared: true,
      binaryUpgradeRequired: true,
      upgradeRequired: true,
    });
    expect(host.uploads).toEqual([]);
  });

  it('rolls back through the constrained node helper', async () => {
    const events: string[] = [];
    const bootstrap = new AgentdBootstrap({
      version: '1.2.3',
      port: 48222,
      binaries,
      onEvent: (_nodeId, event) => events.push(event),
    });
    const host = new FakeHost([]);
    await bootstrap.rollback(host, IDENTITY.nodeId);
    expect(host.execs).toContain('sudo -n /usr/local/sbin/flock-node-admin rollback');
    expect(events).toEqual(['rolled_back']);
  });
});
