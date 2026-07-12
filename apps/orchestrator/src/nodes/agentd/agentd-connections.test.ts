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
import { evaluateAgentdCompatibility } from './agentd-compatibility.js';

const IDENTITY = {
  nodeId: 'node-upgrade-test',
  credential: '0123456789abcdef0123456789abcdef',
};

function daemon(
  sessions: () => string[],
  valid = true,
  version = '0.2.9',
  capabilities = ['pty'],
  supportedProtocol = AGENTD_PROTOCOL_VERSION,
): Duplex {
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
        if (control.protocolVersion !== supportedProtocol) {
          output.write(
            encodeControl({ op: 'error', message: 'unsupported agentd protocol version' }),
          );
          return;
        }
        challenge = {
          op: 'challenge',
          protocolVersion: supportedProtocol,
          nodeId: IDENTITY.nodeId,
          clientNonce: control.clientNonce,
          serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          daemonVersion: version,
          capabilities,
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
            protocolVersion: supportedProtocol,
            nodeId: IDENTITY.nodeId,
            daemonVersion: challenge!.daemonVersion,
            capabilities: challenge!.capabilities,
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
  const policy = {
    schemaVersion: 1 as const,
    preferredDaemonVersion: '0.3.0',
    minimumDaemonVersion: '0.2.0',
    preferredProtocolVersion: AGENTD_PROTOCOL_VERSION,
    supportedProtocolVersions: [AGENTD_PROTOCOL_VERSION],
    requiredCapabilities: ['pty'],
    supportWindow: { minorReleases: 1, minimumDays: 90 },
  };
  return {
    inspect: vi.fn(async () => ({
      installedVersion: '0.2.9',
      expectedVersion: '0.3.0',
      running: true,
      servicePrepared: true,
      binaryUpgradeRequired: true,
      upgradeRequired: true,
      compatibility: evaluateAgentdCompatibility(policy, {
        installedVersion: '0.2.9',
        servicePrepared: true,
      }),
    })),
    policy: () => policy,
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

  it('keeps mandatory-old sessions attachable but blocks new sessions until upgrade', async () => {
    const basePolicy = bootstrap().policy();
    const requiredPolicy = { ...basePolicy, minimumDaemonVersion: '0.3.0' };
    const rollout = bootstrap({
      policy: () => requiredPolicy,
      inspect: vi.fn(async () => ({
        installedVersion: '0.2.9',
        expectedVersion: '0.3.0',
        running: true,
        servicePrepared: true,
        binaryUpgradeRequired: true,
        upgradeRequired: true,
        compatibility: evaluateAgentdCompatibility(requiredPolicy, {
          installedVersion: '0.2.9',
          servicePrepared: true,
        }),
      })),
    });
    const connections = new AgentdConnections({ identityFor: async () => IDENTITY });
    const client = await connections.clientForRemote(
      IDENTITY.nodeId,
      new Host(() => daemon(() => ['existing'], true, '0.2.9')),
      rollout,
    );

    await expect(client.list()).resolves.toHaveLength(1);
    await expect(client.open({ id: 'new-session' })).rejects.toThrow(/must be upgraded/);
    expect(connections.upgradeFor(IDENTITY.nodeId)).toMatchObject({
      status: 'deferred',
      requirement: 'required',
    });
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
        compatibility: evaluateAgentdCompatibility(rollout.policy(), {
          installedVersion: '0.2.9',
          servicePrepared: true,
        }),
      })),
    });
    const connections = new AgentdConnections({
      identityFor: async () => IDENTITY,
    });

    await connections.clientForRemote(IDENTITY.nodeId, host, rollout);
    expect(rollout.rollback).toHaveBeenCalledWith(host, IDENTITY.nodeId);
    expect(connections.upgradeFor(IDENTITY.nodeId)).toMatchObject({ status: 'rolled_back' });
  });

  it('does not downgrade a newer daemon that satisfies the authenticated policy', async () => {
    const rollout = bootstrap({
      inspect: vi.fn(async () => ({
        installedVersion: '0.4.0',
        expectedVersion: '0.3.0',
        running: true,
        servicePrepared: true,
        binaryUpgradeRequired: false,
        upgradeRequired: false,
        compatibility: evaluateAgentdCompatibility(bootstrap().policy(), {
          installedVersion: '0.4.0',
          servicePrepared: true,
        }),
      })),
    });
    const connections = new AgentdConnections({ identityFor: async () => IDENTITY });

    await connections.clientForRemote(
      IDENTITY.nodeId,
      new Host(() => daemon(() => [], true, '0.4.0')),
      rollout,
    );

    expect(rollout.ensureRunning).not.toHaveBeenCalled();
    expect(connections.compatibilityFor(IDENTITY.nodeId)).toMatchObject({
      state: 'compatible',
      reason: 'newer-compatible',
      binaryReplacement: false,
    });
  });

  it('replaces an equal-version binary that lacks a required authenticated capability', async () => {
    let connection = 0;
    const rollout = bootstrap({
      inspect: vi.fn(async () => ({
        installedVersion: '0.3.0',
        expectedVersion: '0.3.0',
        running: true,
        servicePrepared: true,
        binaryUpgradeRequired: false,
        upgradeRequired: false,
        compatibility: evaluateAgentdCompatibility(bootstrap().policy(), {
          installedVersion: '0.3.0',
          servicePrepared: true,
        }),
      })),
    });
    const connections = new AgentdConnections({ identityFor: async () => IDENTITY });

    await connections.clientForRemote(
      IDENTITY.nodeId,
      new Host(() => {
        connection += 1;
        return daemon(() => [], true, '0.3.0', connection === 1 ? [] : ['pty']);
      }),
      rollout,
    );

    expect(rollout.ensureRunning).toHaveBeenCalledWith(hostContaining(), IDENTITY, {
      forceBinaryReplacement: true,
    });
    expect(connections.compatibilityFor(IDENTITY.nodeId)?.state).toBe('compatible');
  });

  it('negotiates the next supported protocol using a fresh authenticated channel', async () => {
    let connectionsOpened = 0;
    const basePolicy = bootstrap().policy();
    const rollout = bootstrap({
      policy: () => ({
        ...basePolicy,
        preferredProtocolVersion: 3,
        supportedProtocolVersions: [3, 2],
      }),
      inspect: vi.fn(async () => ({
        installedVersion: '0.3.0',
        expectedVersion: '0.3.0',
        running: true,
        servicePrepared: true,
        binaryUpgradeRequired: false,
        upgradeRequired: false,
        compatibility: evaluateAgentdCompatibility(basePolicy, {
          installedVersion: '0.3.0',
          servicePrepared: true,
        }),
      })),
    });
    const connections = new AgentdConnections({ identityFor: async () => IDENTITY });

    await connections.clientForRemote(
      IDENTITY.nodeId,
      new Host(() => {
        connectionsOpened += 1;
        return daemon(() => [], true, '0.3.0', ['pty'], 2);
      }),
      rollout,
    );

    expect(connectionsOpened).toBe(2);
    expect(connections.compatibilityFor(IDENTITY.nodeId)?.protocolVersion).toBe(2);
  });
});

function hostContaining(): unknown {
  return expect.objectContaining({ forwardOut: expect.any(Function) });
}
