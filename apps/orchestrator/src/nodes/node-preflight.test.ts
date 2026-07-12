import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import type { AgentdExecResult, AgentdHost } from './agentd/ssh-agentd-host.js';
import { preflightRemoteNode } from './node-preflight.js';

class Host implements AgentdHost {
  constructor(private readonly run: (command: string) => Partial<AgentdExecResult>) {}
  async exec(command: string): Promise<AgentdExecResult> {
    return { code: 0, stdout: '', stderr: '', ...this.run(command) };
  }
  async uploadFile(): Promise<void> {}
  async forwardOut() {
    return new PassThrough();
  }
}

const input = {
  nodeId: '11111111-1111-4111-8111-111111111111',
  expectedAgentdVersion: '0.3.0',
  workspaces: ['/srv/flock/workspaces/demo'],
};

describe('remote node preflight', () => {
  it('reports a prepared node with a writable workspace and agent as ready', async () => {
    const host = new Host((command) => {
      if (command === 'uname -s; uname -m') return { stdout: 'Linux\nx86_64\n' };
      if (command.startsWith('df -Pk')) return { stdout: '1048576\n' };
      if (command.includes(' preflight')) return { stdout: 'prepared-v1 runtime=flock-agent\n' };
      if (command.includes('flock-agentd version')) return { stdout: '0.3.0\n' };
      if (command.includes('check-workspace')) return { stdout: 'writable\n' };
      if (command.endsWith('agent-version codex')) return { stdout: '/usr/bin/codex\tcodex 1\n' };
      if (command.includes('agent-version')) return { code: 1 };
      return {};
    });
    const result = await preflightRemoteNode({ ...input, host });
    expect(result.ready).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'agent:codex', status: 'pass' }),
    );
  });

  it('fails when preparation, workspace access, or every agent is missing', async () => {
    const host = new Host((command) => {
      if (command === 'uname -s; uname -m') return { stdout: 'Linux\naarch64\n' };
      if (command.startsWith('df -Pk')) return { stdout: '1048576\n' };
      if (command.includes('flock-agentd version')) return { code: 1 };
      return { code: 1 };
    });
    const result = await preflightRemoteNode({ ...input, host });
    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'preparation', status: 'fail' }),
        expect.objectContaining({ id: `workspace:${input.workspaces[0]}`, status: 'fail' }),
        expect.objectContaining({ id: 'agent:any', status: 'fail' }),
      ]),
    );
  });

  it('warns instead of failing when the prepared node only needs a daemon upgrade', async () => {
    const host = new Host((command) => {
      if (command === 'uname -s; uname -m') return { stdout: 'Linux\nx86_64\n' };
      if (command.startsWith('df -Pk')) return { stdout: '1048576\n' };
      if (command.includes(' preflight')) return { stdout: 'prepared-v1\n' };
      if (command.includes('flock-agentd version')) return { stdout: '0.2.9\n' };
      if (command.includes('check-workspace')) return { stdout: 'writable\n' };
      if (command.endsWith('agent-version claude')) return { stdout: '/bin/claude\t1.0\n' };
      if (command.includes('agent-version')) return { code: 1 };
      return {};
    });
    const result = await preflightRemoteNode({ ...input, host });
    expect(result.ready).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'daemon-version', status: 'warning' }),
    );
  });
});
