import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AgentdLocalTransport } from './agentd-local-transport.js';
import type { AgentdConnections } from './agentd-connections.js';
import { TransportDisposedError, TransportInvalidCommandError } from '../transport/transport.js';

function fixture() {
  const execLocal = vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }));
  const stream = new PassThrough();
  const dialLocalTcp = vi.fn(async () => stream);
  const connections = { execLocal, dialLocalTcp } as unknown as AgentdConnections;
  return {
    transport: new AgentdLocalTransport(connections, () => 'local-1'),
    execLocal,
    dialLocalTcp,
    stream,
  };
}

describe('AgentdLocalTransport', () => {
  it('maps command options onto one bounded runtime exec request', async () => {
    const { transport, execLocal } = fixture();
    await expect(
      transport.exec(['git', 'status'], {
        cwd: '/home/flock-agent/workspace',
        env: { A: 'one', OMIT: undefined },
        input: 'input',
        timeoutMs: 1234,
      }),
    ).resolves.toMatchObject({ stdout: 'ok' });
    expect(execLocal).toHaveBeenCalledWith('local-1', {
      command: ['git', 'status'],
      cwd: '/home/flock-agent/workspace',
      env: ['A=one'],
      input: 'input',
      timeoutMs: 1234,
    });
  });

  it('dials only the typed numeric-loopback target through agentd', async () => {
    const { transport, dialLocalTcp, stream } = fixture();
    await expect(transport.dialTcp(4321, '::1')).resolves.toBe(stream);
    expect(dialLocalTcp).toHaveBeenCalledWith('local-1', 4321, '::1');
  });

  it('rejects empty commands, missing identity, and use after dispose', async () => {
    const { transport } = fixture();
    await expect(transport.exec([])).rejects.toBeInstanceOf(TransportInvalidCommandError);
    const missing = new AgentdLocalTransport({} as AgentdConnections, () => '');
    await expect(missing.exec(['true'])).rejects.toThrow('identity');
    await transport.dispose();
    await expect(transport.exec(['true'])).rejects.toBeInstanceOf(TransportDisposedError);
  });
});
