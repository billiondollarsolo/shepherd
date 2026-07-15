import net, { type Socket } from 'node:net';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeAgentdClient } from './agentd-client.js';
import { controlMac } from './control-auth.js';
import { controlCredentialId } from './control-auth.js';
import {
  AGENTD_PROTOCOL_VERSION,
  encodeControl,
  encodeFrame,
  FrameDecoder,
  FrameType,
  type AgentdControl,
} from './protocol.js';

const identity = {
  nodeId: 'node-client-test',
  credential: '0123456789abcdef0123456789abcdef',
};
const capabilities = [
  'pty',
  'resize',
  'scrollback',
  'listening_ports_v1',
  'exec_v1',
  'tcp_tunnel_v1',
];
const daemonVersion = '0.3.0';
const sockets: Socket[] = [];
const servers: net.Server[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

async function connectToFakeDaemon(
  handler: (control: AgentdControl, socket: Socket) => void,
  frameHandler?: (type: number, payload: Buffer, socket: Socket) => void,
): Promise<NodeAgentdClient> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      decoder.push(chunk, (type, payload) => {
        if (type === FrameType.Control) {
          handler(JSON.parse(payload.toString('utf8')) as AgentdControl, socket);
        } else {
          frameHandler?.(type, payload, socket);
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

  it('executes bounded commands on a dedicated authenticated operation link', async () => {
    let challenge: AgentdControl | undefined;
    const client = await connectToFakeDaemon((control, socket) => {
      if (control.op === 'hello') {
        expect(control.connectionRole).toBe('operation');
        challenge = {
          op: 'challenge',
          protocolVersion: AGENTD_PROTOCOL_VERSION,
          nodeId: identity.nodeId,
          clientNonce: control.clientNonce,
          serverNonce: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          daemonVersion,
          capabilities,
          credentialId: controlCredentialId(identity.credential),
          connectionRole: 'operation',
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
        socket.write(
          encodeControl({
            op: 'helloOk',
            protocolVersion: AGENTD_PROTOCOL_VERSION,
            nodeId: identity.nodeId,
            daemonVersion,
            capabilities,
            connectionRole: 'operation',
          }),
        );
      } else if (control.op === 'exec') {
        expect(control.command).toEqual(['sh', '-c', 'printf ok']);
        socket.write(
          encodeControl({
            op: 'execResult',
            id: control.id,
            code: 7,
            stdout: 'out',
            stderr: 'err',
            stdoutTruncated: true,
          }),
        );
      }
    });
    await client.hello(identity, AGENTD_PROTOCOL_VERSION, 'operation');
    await expect(client.exec({ command: ['sh', '-c', 'printf ok'] })).resolves.toEqual({
      exitCode: 7,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    client.dispose();
  });

  it('relays TCP data on a dedicated operation link', async () => {
    let challenge: AgentdControl | undefined;
    const client = await connectToFakeDaemon(
      (control, socket) => {
        if (control.op === 'hello') {
          challenge = {
            op: 'challenge',
            protocolVersion: AGENTD_PROTOCOL_VERSION,
            nodeId: identity.nodeId,
            clientNonce: control.clientNonce,
            serverNonce: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
            daemonVersion,
            capabilities,
            credentialId: controlCredentialId(identity.credential),
            connectionRole: 'operation',
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
          socket.write(
            encodeControl({
              op: 'helloOk',
              protocolVersion: AGENTD_PROTOCOL_VERSION,
              nodeId: identity.nodeId,
              daemonVersion,
              capabilities,
              connectionRole: 'operation',
            }),
          );
        } else if (control.op === 'dialTcp') {
          expect(control).toMatchObject({ targetHost: '127.0.0.1', targetPort: 4173 });
          socket.write(encodeControl({ op: 'tcpConnected', id: control.id }));
        }
      },
      (type, payload, socket) => {
        if (type === FrameType.TcpInput) {
          socket.write(
            encodeFrame(FrameType.TcpOutput, Buffer.concat([Buffer.from('echo:'), payload])),
          );
        }
      },
    );
    await client.hello(identity, AGENTD_PROTOCOL_VERSION, 'operation');
    const tunnel = await client.dialTcp(4173);
    tunnel.write('hello');
    const [data] = (await once(tunnel, 'data')) as [Buffer];
    expect(data.toString()).toBe('echo:hello');
    tunnel.destroy();
  });
});
