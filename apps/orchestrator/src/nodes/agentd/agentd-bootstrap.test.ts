/**
 * AgentdBootstrap — unit tests against a fake {@link AgentdHost} that records
 * exec/upload calls and returns scripted command output. Verifies the
 * ship/launch/upgrade decisions without a real node:
 *   - skips upload when the installed version already matches;
 *   - detects arch, resolves the matched binary, uploads + atomically installs
 *     when the version is missing/stale;
 *   - emits a systemd-or-nohup launch script;
 *   - normalises uname arch to GOARCH and rejects unsupported platforms.
 */
import { describe, expect, it, vi } from 'vitest';
import { PassThrough, type Duplex } from 'node:stream';

import { AgentdBootstrap, type AgentdBinaryProvider, type AgentdPlatform } from './agentd-bootstrap.js';
import type { AgentdExecResult, AgentdHost } from './ssh-agentd-host.js';

interface ExecRule {
  match: RegExp;
  result: Partial<AgentdExecResult>;
}

class FakeHost implements AgentdHost {
  execs: string[] = [];
  uploads: Array<{ local: string; remote: string; mode?: number }> = [];
  /** Whether the loopback port "accepts" connections (the health probe). */
  listening = false;
  constructor(private readonly rules: ExecRule[]) {}

  async exec(command: string): Promise<AgentdExecResult> {
    this.execs.push(command);
    for (const r of this.rules) {
      if (r.match.test(command)) {
        return { code: 0, stdout: '', stderr: '', ...r.result };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  async uploadFile(local: string, remote: string, mode?: number): Promise<void> {
    this.uploads.push({ local, remote, mode });
  }
  async forwardOut(): Promise<Duplex> {
    if (!this.listening) throw new Error('connection refused');
    return new PassThrough();
  }
}

const binaries: AgentdBinaryProvider = {
  resolve: async (p: AgentdPlatform) => `/dist/flock-agentd-${p.os}-${p.arch}`,
};

function make(host: FakeHost, version = '1.2.3') {
  return new AgentdBootstrap({ version, port: 48222, binaries, secret: 'sek' });
}

describe('AgentdBootstrap', () => {
  it('skips upload when the installed version already matches', async () => {
    const host = new FakeHost([{ match: /version/, result: { stdout: '1.2.3\n' } }]);
    const ep = await make(host).ensureRunning(host);
    expect(ep).toEqual({ host: '127.0.0.1', port: 48222 });
    expect(host.uploads).toHaveLength(0);
    // Did NOT run uname (no need to pick a binary) but DID launch.
    expect(host.execs.some((c) => c.includes('uname'))).toBe(false);
    expect(host.execs.some((c) => c.includes('systemctl'))).toBe(true);
  });

  it('leaves a healthy daemon of the right version untouched (no restart)', async () => {
    // version matches AND the port is already listening → must NOT relaunch
    // (relaunching would kill the running sessions on every reconnect).
    const host = new FakeHost([{ match: /version/, result: { stdout: '1.2.3\n' } }]);
    host.listening = true; // port already accepts connections
    const ep = await make(host).ensureRunning(host);
    expect(ep).toEqual({ host: '127.0.0.1', port: 48222 });
    expect(host.uploads).toHaveLength(0);
    expect(host.execs.some((c) => c.includes('systemctl') || c.includes('setsid'))).toBe(false);
  });

  it('ships + installs the arch-matched binary when version is stale', async () => {
    const host = new FakeHost([
      { match: /version/, result: { stdout: '0.0.1\n' } }, // stale
      { match: /uname/, result: { stdout: 'Linux\nx86_64\n' } },
      { match: /printf %s "\$HOME"/, result: { stdout: '/home/flock' } },
    ]);
    await make(host).ensureRunning(host);
    expect(host.uploads).toHaveLength(1);
    expect(host.uploads[0]?.local).toBe('/dist/flock-agentd-linux-amd64');
    expect(host.uploads[0]?.remote).toBe('/home/flock/.flock/agentd/flock-agentd.new');
    expect(host.uploads[0]?.mode).toBe(0o700);
    // atomic move into place
    expect(host.execs.some((c) => c.includes('mv -f') && c.includes('flock-agentd'))).toBe(true);
  });

  it('installs when the binary is absent (empty version)', async () => {
    const host = new FakeHost([
      { match: /version/, result: { code: 1, stdout: '' } },
      { match: /uname/, result: { stdout: 'Linux\naarch64\n' } },
      { match: /printf %s "\$HOME"/, result: { stdout: '/root' } },
    ]);
    await make(host).ensureRunning(host);
    expect(host.uploads[0]?.local).toBe('/dist/flock-agentd-linux-arm64');
  });

  it('writes the secret to a 0600 EnvironmentFile (not inline) + a nohup fallback', async () => {
    const host = new FakeHost([{ match: /version/, result: { stdout: '1.2.3\n' } }]);
    await make(host).ensureRunning(host);
    const launch = host.execs.find((c) => c.includes('flock-agentd.service'));
    expect(launch).toBeTruthy();
    // Secret goes in a chmod-600 EnvironmentFile, NEVER inline in the 0644 unit.
    expect(launch).not.toContain('Environment=FLOCK_AGENTD_SECRET=');
    expect(launch).toContain('agentd.env');
    expect(launch).toContain('chmod 600');
    expect(launch).toContain('EnvironmentFile=');
    expect(launch).toContain('enable-linger');
    expect(launch).toContain('--addr 127.0.0.1:48222');
    expect(launch).toContain('setsid'); // detached fallback branch present
  });

  it('rejects an unsupported architecture', async () => {
    const host = new FakeHost([
      { match: /version/, result: { stdout: '0.0.1\n' } },
      { match: /uname/, result: { stdout: 'Linux\nmips\n' } },
    ]);
    await expect(make(host).ensureRunning(host)).rejects.toThrow(/platform/i);
  });

  it('throws if the launch script fails', async () => {
    const host = new FakeHost([
      { match: /version/, result: { stdout: '1.2.3\n' } },
      { match: /systemctl|setsid|flock-agentd\.service|set -e/, result: { code: 1, stderr: 'boom' } },
    ]);
    const warn = vi.fn();
    const boot = new AgentdBootstrap({ version: '1.2.3', port: 48222, binaries, logger: { warn } });
    await expect(boot.ensureRunning(host)).rejects.toThrow(/launch/i);
    expect(warn).toHaveBeenCalled();
  });
});
