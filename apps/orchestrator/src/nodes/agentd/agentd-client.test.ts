import net, { type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeAgentdClient } from './agentd-client.js';
import { controlMac } from './control-auth.js';
import { controlCredentialId } from './control-auth.js';
import {
  AGENTD_PROTOCOL_VERSION,
  encodeControl,
  FrameDecoder,
  FrameType,
  type AgentdControl,
} from './protocol.js';

const identity = {
  nodeId: 'node-client-test',
  credential: '0123456789abcdef0123456789abcdef',
};
const capabilities = ['pty', 'resize', 'scrollback', 'listening_ports_v1'];
const daemonVersion = '0.3.0';
const sockets: Socket[] = [];
const servers: net.Server[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

async function connectToFakeDaemon(
  handler: (control: AgentdControl, socket: Socket) => void,
): Promise<NodeAgentdClient> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      decoder.push(chunk, (type, payload) => {
        if (type === FrameType.Control) {
          handler(JSON.parse(payload.toString('utf8')) as AgentdControl, socket);
        }
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  const socket = net.connect(address.port, '127.0.0.1');
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new NodeAgentdClient(socket);
}

describe('NodeAgentdClient v2 handshake', () => {
  it('authenticates both peers and binds the negotiated identity', async () => {
    let challenge: AgentdControl | undefined;
    const client = await connectToFakeDaemon((control, socket) => {
      if (control.op === 'hello') {
        challenge = {
          op: 'challenge',
          protocolVersion: AGENTD_PROTOCOL_VERSION,
          nodeId: identity.nodeId,
          clientNonce: control.clientNonce,
          serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          daemonVersion,
          capabilities,
          credentialId: controlCredentialId(identity.credential),
        };
        challenge.serverMac = controlMac({
          credential: identity.credential,
          role: 'server',
          nodeId: identity.nodeId,
          clientNonce: challenge.clientNonce!,
          serverNonce: challenge.serverNonce!,
          daemonVersion,
          capabilities,
        });
        socket.write(encodeControl(challenge));
      } else if (control.op === 'authenticate') {
        const expected = controlMac({
          credential: identity.credential,
          role: 'client',
          nodeId: identity.nodeId,
          clientNonce: challenge!.clientNonce!,
          serverNonce: challenge!.serverNonce!,
          daemonVersion,
          capabilities,
        });
        expect(control.clientMac).toBe(expected);
        socket.write(
          encodeControl({
            op: 'helloOk',
            protocolVersion: AGENTD_PROTOCOL_VERSION,
            nodeId: identity.nodeId,
            daemonVersion,
            capabilities,
          }),
        );
      } else if (control.op === 'rotateCredential') {
        socket.write(
          encodeControl({
            op: 'credentialRotated',
            credentialId: controlCredentialId(control.newCredential!),
          }),
        );
      } else if (control.op === 'listeningPorts') {
        socket.write(
          encodeControl({
            op: 'listeningPorts',
            observedAt: '2026-07-14T00:00:00.000Z',
            listeningPorts: [
              {
                observationKey: 'tcp:127.0.0.1:3000:123',
                address: '127.0.0.1',
                targetHost: '127.0.0.1',
                port: 3000,
                pid: 42,
                process: 'vite',
                cwd: '/work/project',
                sessionId: 'session-a',
              },
            ],
          }),
        );
      }
    });
    await expect(client.hello(identity)).resolves.toMatchObject({
      daemonVersion,
      protocolVersion: AGENTD_PROTOCOL_VERSION,
      capabilities,
    });
    await expect(
      client.rotateCredential('new-credential-value-0123456789abcdef'),
    ).resolves.toBeUndefined();
    await expect(client.listeningPorts()).resolves.toEqual({
      ports: [
        {
          observationKey: 'tcp:127.0.0.1:3000:123',
          address: '127.0.0.1',
          targetHost: '127.0.0.1',
          port: 3000,
          pid: 42,
          process: 'vite',
          cwd: '/work/project',
          sessionId: 'session-a',
        },
      ],
      observedAt: '2026-07-14T00:00:00.000Z',
      degradedReason: null,
    });
    client.dispose();
  });

  it('rejects a daemon that cannot prove possession of the node credential', async () => {
    const client = await connectToFakeDaemon((control, socket) => {
      if (control.op !== 'hello') return;
      socket.write(
        encodeControl({
          op: 'challenge',
          protocolVersion: AGENTD_PROTOCOL_VERSION,
          nodeId: identity.nodeId,
          clientNonce: control.clientNonce,
          serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          daemonVersion,
          capabilities,
          credentialId: controlCredentialId(identity.credential),
          serverMac: 'invalid',
        }),
      );
    });
    await expect(client.hello(identity)).rejects.toThrow(/daemon authentication failed/);
    client.dispose();
  });

  it('rejects a direct unauthenticated hello response', async () => {
    const client = await connectToFakeDaemon((control, socket) => {
      if (control.op === 'hello') {
        socket.write(
          encodeControl({ op: 'helloOk', protocolVersion: 1, daemonVersion: 'unsupported' }),
        );
      }
    });
    await expect(client.hello(identity)).rejects.toThrow(/unauthenticated handshake/);
    client.dispose();
  });
});
