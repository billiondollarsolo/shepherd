import { describe, expect, it } from 'vitest';

import { AgentdConnections, classifyAgentdFailure } from './agentd-connections.js';

describe('agentd connection diagnostics', () => {
  it.each([
    ['agentd daemon authentication failed', 'authentication'],
    ['control credential was rejected', 'authentication'],
    ['agentd returned an invalid authentication challenge', 'authentication'],
    ['unsupported protocol version 7', 'protocol'],
    ['capabilities do not match', 'protocol'],
    ['binary checksum mismatch', 'enrollment'],
    ['failed to install system service', 'enrollment'],
    ['connect ECONNREFUSED 127.0.0.1:48222', 'network'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyAgentdFailure(new Error(message))).toBe(expected);
  });

  it('does not include raw error content in the public category', () => {
    expect(classifyAgentdFailure(new Error('connect failed with secret=do-not-leak'))).toBe(
      'network',
    );
  });

  it('retains one redacted failure and deduplicates repeated audit noise', async () => {
    const audit: string[] = [];
    const connections = new AgentdConnections({
      socketPath: `/tmp/flock-agentd-missing-${process.pid}-${Date.now()}.sock`,
      identityFor: async (nodeId) => ({ nodeId, credential: 'x'.repeat(32) }),
      onAudit: (_nodeId, event) => audit.push(event),
    });

    await expect(connections.clientForLocal('node-a')).rejects.toThrow();
    await expect(connections.clientForLocal('node-a')).rejects.toThrow();

    expect(connections.failureFor('node-a')).toMatchObject({
      code: 'network',
      message: 'The daemon control channel is unreachable.',
    });
    expect(JSON.stringify(connections.failureFor('node-a'))).not.toContain('flock-agentd-missing');
    expect(audit).toEqual(['disconnected']);
  });
});
