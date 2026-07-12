import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { AgentdConnections, classifyAgentdFailure } from './agentd-connections.js';
import type { AgentdBootstrap } from './agentd-bootstrap.js';
import { controlCredentialId, controlMac } from './control-auth.js';
import {
  AGENTD_PROTOCOL_VERSION,
  encodeControl,
  FrameDecoder,
  FrameType,
  type AgentdControl,
} from './protocol.js';
import type { AgentdHost } from './ssh-agentd-host.js';

const IDENTITY = {
  nodeId: 'node-upgrade-test',
  credential: '0123456789abcdef0123456789abcdef',
};

function daemon(sessions: () => string[], valid = true, version = '0.2.9'): Duplex {
  const input = new PassThrough();
  const output = new PassThrough();
  const socket = Duplex.from({ writable: input, readable: output });
  const decoder = new FrameDecoder();
  let challenge: AgentdControl | null = null;
  input.on('data', (chunk: Buffer) => {
    decoder.push(chunk, (type, payload) => {
      if (type !== FrameType.Control) return;
      const control = JSON.parse(payload.toString('utf8')) as AgentdControl;
      if (control.op === 'hello') {
        challenge = {
          op: 'challenge',
          protocolVersion: AGENTD_PROTOCOL_VERSION,
          nodeId: IDENTITY.nodeId,
          clientNonce: control.clientNonce,
          serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          daemonVersion: version,
          capabilities: ['pty'],
          credentialId: controlCredentialId(IDENTITY.credential),
        };
        challenge.serverMac = valid
          ? controlMac({
              credential: IDENTITY.credential,
              role: 'server',
              nodeId: IDENTITY.nodeId,
              clientNonce: challenge.clientNonce!,
              serverNonce: challenge.serverNonce!,
              daemonVersion: challenge.daemonVersion!,
              capabilities: challenge.capabilities!,
            })
          : 'invalid';
        output.write(encodeControl(challenge));
      } else if (control.op === 'authenticate') {
        output.write(
          encodeControl({
            op: 'helloOk',
            protocolVersion: AGENTD_PROTOCOL_VERSION,
            nodeId: IDENTITY.nodeId,
            daemonVersion: challenge!.daemonVersion,
          }),
        );
      } else if (control.op === 'list') {
        output.write(
          encodeControl({
            op: 'sessions',
            sessions: sessions().map((id) => ({ id, kind: 'agent', cwd: '/workspace' })),
          }),
        );
      }
    });
  });
  return socket;
}

class Host implements AgentdHost {
  constructor(private readonly connect: () => Duplex) {}
  async exec() {
    return { code: 0, stdout: '', stderr: '' };
  }
  async uploadFile(): Promise<void> {}
  async forwardOut(): Promise<Duplex> {
    return this.connect();
  }
}

function bootstrap(overrides: Partial<AgentdBootstrap> = {}): AgentdBootstrap {
  return {
    inspect: vi.fn(async () => ({
      installedVersion: '0.2.9',
      expectedVersion: '0.3.0',
      running: true,
      servicePrepared: true,
      binaryUpgradeRequired: true,
      upgradeRequired: true,
    })),
    endpoint: () => ({ host: '127.0.0.1', port: 48222 }),
    ensureRunning: vi.fn(async () => ({ host: '127.0.0.1', port: 48222 })),
    rollback: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AgentdBootstrap;
}

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

  it('defers a daemon upgrade while authenticated sessions are active', async () => {
    let sessions = ['session-1'];
    let connection = 0;
    const host = new Host(() =>
      daemon(() => sessions, true, ++connection >= 3 ? '0.3.0' : '0.2.9'),
    );
    const rollout = bootstrap();
    const connections = new AgentdConnections({
      identityFor: async () => IDENTITY,
    });

    await connections.clientForRemote(IDENTITY.nodeId, host, rollout);
    expect(connections.upgradeFor(IDENTITY.nodeId)).toMatchObject({
      status: 'deferred',
      activeSessions: 1,
      installedVersion: '0.2.9',
      expectedVersion: '0.3.0',
    });
    expect(rollout.ensureRunning).not.toHaveBeenCalled();

    sessions = [];
    await connections.clientForRemote(IDENTITY.nodeId, host, rollout);
    expect(rollout.ensureRunning).toHaveBeenCalledOnce();
    expect(connections.upgradeFor(IDENTITY.nodeId)).toBeNull();
  });

  it('rolls back a candidate that cannot complete authenticated health validation', async () => {
    let connection = 0;
    const host = new Host(() => {
      connection += 1;
      return daemon(() => [], connection !== 1, connection === 1 ? '0.3.0' : '0.2.9');
    });
    const rollout = bootstrap({
      inspect: vi.fn(async () => ({
        installedVersion: '0.2.9',
        expectedVersion: '0.3.0',
        running: false,
        servicePrepared: true,
        binaryUpgradeRequired: true,
        upgradeRequired: true,
      })),
    });
    const connections = new AgentdConnections({
      identityFor: async () => IDENTITY,
    });

    await connections.clientForRemote(IDENTITY.nodeId, host, rollout);
    expect(rollout.rollback).toHaveBeenCalledWith(host, IDENTITY.nodeId);
    expect(connections.upgradeFor(IDENTITY.nodeId)).toMatchObject({ status: 'rolled_back' });
  });
});
