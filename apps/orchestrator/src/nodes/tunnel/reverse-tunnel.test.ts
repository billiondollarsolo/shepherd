/**
 * ReverseTunnel — UNIT test of the loopback-bound reverse-tunnel logic (US-9),
 * runs under `pnpm test:unit`. No real sshd: a fake {@link TunnelHost} and a fake
 * hook dialer are injected so the binding + channel-piping behaviour is tested
 * deterministically. The real-ssh path (a `curl localhost` on a dockerized node
 * reaching the orchestrator) is covered by reverse-tunnel.int.test.ts.
 *
 * The load-bearing assertion (NFR-SEC4 / spec §9 US-9 second bullet): the tunnel
 * binds the remote forward to LOOPBACK ONLY (`127.0.0.1`) and NEVER to
 * `0.0.0.0`/empty — the property that, with OpenSSH, guarantees no GatewayPorts
 * exposure of the hook port on the node's external interfaces.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReverseTunnel,
  TUNNEL_LOOPBACK_BIND_ADDRESS,
  type ForwardedChannel,
  type ForwardedConnectionInfo,
  type HookEndpointTarget,
  type TunnelHost,
} from './reverse-tunnel.js';

/** A duplex stand-in for an ssh2 forwarded-tcpip channel. */
class FakeChannel extends PassThrough implements ForwardedChannel {
  // PassThrough already provides pipe/on/end/destroy with compatible signatures.
}

/**
 * A controllable fake of the ssh2 Client's reverse-forward surface. Records the
 * bind address/port it was asked to forward, lets the test assign a port, and
 * lets the test emit inbound `tcp connection` events.
 */
class FakeTunnelHost implements TunnelHost {
  forwardInCalls: Array<{ bindAddr: string; bindPort: number }> = [];
  unforwardInCalls: Array<{ bindAddr: string; bindPort: number }> = [];
  assignedPort = 54321;
  forwardShouldFail: Error | null = null;
  private readonly emitter = new EventEmitter();

  forwardIn(
    bindAddr: string,
    bindPort: number,
    callback: (err: Error | undefined, port: number) => void,
  ): boolean {
    this.forwardInCalls.push({ bindAddr, bindPort });
    if (this.forwardShouldFail) {
      callback(this.forwardShouldFail, 0);
      return true;
    }
    callback(undefined, bindPort === 0 ? this.assignedPort : bindPort);
    return true;
  }

  unforwardIn(bindAddr: string, bindPort: number, callback?: (err?: Error) => void): void {
    this.unforwardInCalls.push({ bindAddr, bindPort });
    callback?.();
  }

  on(event: 'tcp connection', listener: (...args: never[]) => void): this {
    this.emitter.on(event, listener as (...a: unknown[]) => void);
    return this;
  }

  off(event: 'tcp connection', listener: (...args: never[]) => void): this {
    this.emitter.off(event, listener as (...a: unknown[]) => void);
    return this;
  }

  /** Test helper: simulate the node opening a forwarded connection. */
  emitConnection(
    info: ForwardedConnectionInfo,
    accept: () => ForwardedChannel,
    reject: () => void,
  ): void {
    this.emitter.emit('tcp connection', info, accept, reject);
  }

  listenerCount(): number {
    return this.emitter.listenerCount('tcp connection');
  }
}

const TARGET: HookEndpointTarget = { host: '127.0.0.1', port: 8080 };

function connInfo(port: number, ip = TUNNEL_LOOPBACK_BIND_ADDRESS): ForwardedConnectionInfo {
  return { destIP: ip, destPort: port, srcIP: '127.0.0.1', srcPort: 40000 };
}

describe('ReverseTunnel — loopback-bound hook tunnel (US-9)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds the remote forward to LOOPBACK only — never 0.0.0.0/empty (NFR-SEC4)', async () => {
    const host = new FakeTunnelHost();
    const tunnel = new ReverseTunnel(host, TARGET);

    await tunnel.start();

    expect(host.forwardInCalls).toHaveLength(1);
    const { bindAddr } = host.forwardInCalls[0]!;
    expect(bindAddr).toBe('127.0.0.1');
    expect(bindAddr).toBe(TUNNEL_LOOPBACK_BIND_ADDRESS);
    // The two ways GatewayPorts could ever leak the port externally:
    expect(bindAddr).not.toBe('0.0.0.0');
    expect(bindAddr).not.toBe('');
    expect(tunnel.bindAddr).toBe('127.0.0.1');

    await tunnel.dispose();
  });

  it('exposes the sshd-assigned loopback port (the port the node curls)', async () => {
    const host = new FakeTunnelHost();
    host.assignedPort = 49152;
    const tunnel = new ReverseTunnel(host, TARGET); // requestedPort defaults to 0

    const port = await tunnel.start();

    expect(host.forwardInCalls[0]!.bindPort).toBe(0); // asked sshd to choose
    expect(port).toBe(49152);
    expect(tunnel.remotePort).toBe(49152);
    expect(tunnel.isActive).toBe(true);

    await tunnel.dispose();
  });

  it('forwards an inbound hook connection to the orchestrator hook endpoint', async () => {
    const host = new FakeTunnelHost();
    const dialed: HookEndpointTarget[] = [];

    // A duplex stand-in for the net.Socket dialed to the orchestrator endpoint.
    // Crucially it does NOT echo (unlike PassThrough): writes from the node-side
    // channel land in `received`, and its readable side (the orchestrator's HTTP
    // response) is a separate Writable so piping channel<->socket forms no loop.
    const received: Buffer[] = [];
    const socket = new Writable({
      write(chunk: Buffer, _enc, cb) {
        received.push(Buffer.from(chunk));
        cb();
      },
    }) as Writable & {
      pipe: (dest: NodeJS.WritableStream) => NodeJS.WritableStream;
      destroy: () => void;
    };
    // The tunnel calls socket.pipe(channel) for the response direction; give the
    // Writable a no-op pipe (no response bytes in this test) so it is a complete
    // duplex-ish mock without re-feeding the channel.
    socket.pipe = ((dest: NodeJS.WritableStream) => dest) as typeof socket.pipe;

    const dialer = (t: HookEndpointTarget): typeof socket => {
      dialed.push(t);
      // Emulate net.Socket: emit 'connect' on next tick so the tunnel wires pipes.
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    };

    const tunnel = new ReverseTunnel(host, TARGET, {
      dialer: dialer as unknown as () => ReturnType<typeof dialer>,
    });
    const port = await tunnel.start();

    const channel = new FakeChannel();
    let accepted = false;
    host.emitConnection(
      connInfo(port),
      () => {
        accepted = true;
        return channel;
      },
      () => {
        throw new Error('connection to our loopback port must be accepted, not rejected');
      },
    );

    expect(accepted).toBe(true);
    expect(dialed).toEqual([TARGET]);

    // Bytes from the node's curl flow to the orchestrator endpoint.
    await new Promise((r) => setTimeout(r, 0));
    channel.write('POST /api/hooks/sess-1 HTTP/1.1\r\n\r\n');
    await new Promise((r) => setTimeout(r, 0));
    expect(Buffer.concat(received).toString()).toContain('/api/hooks/sess-1');

    await tunnel.dispose();
  });

  it('ignores forwarded connections destined for a DIFFERENT port', async () => {
    const host = new FakeTunnelHost();
    host.assignedPort = 50000;
    let dialerCalls = 0;
    const tunnel = new ReverseTunnel(host, TARGET, {
      dialer: (() => {
        dialerCalls += 1;
        return new PassThrough();
      }) as unknown as () => PassThrough,
    });
    await tunnel.start();

    let rejected = false;
    host.emitConnection(
      connInfo(60000), // not our port
      () => {
        throw new Error('must not accept a connection for a foreign port');
      },
      () => {
        rejected = true;
      },
    );

    // Foreign-port connections are left for their owner: neither accepted by us
    // nor (necessarily) rejected by us, and never dialed to our endpoint.
    expect(dialerCalls).toBe(0);
    expect(rejected).toBe(false);

    await tunnel.dispose();
  });

  it('start() rejects when the remote forward request fails', async () => {
    const host = new FakeTunnelHost();
    host.forwardShouldFail = new Error('remote port forwarding refused');
    const tunnel = new ReverseTunnel(host, TARGET);

    await expect(tunnel.start()).rejects.toThrow(/forwarding refused/);
    expect(tunnel.isActive).toBe(false);
  });

  it('stop() cancels the remote forward and removes the connection listener', async () => {
    const host = new FakeTunnelHost();
    const tunnel = new ReverseTunnel(host, TARGET);
    const port = await tunnel.start();

    expect(host.listenerCount()).toBe(1);
    await tunnel.stop();

    expect(host.unforwardInCalls).toEqual([{ bindAddr: '127.0.0.1', bindPort: port }]);
    expect(host.listenerCount()).toBe(0);
    expect(tunnel.remotePort).toBeNull();
  });

  it('dispose() is permanent: a disposed tunnel refuses to start again', async () => {
    const host = new FakeTunnelHost();
    const tunnel = new ReverseTunnel(host, TARGET);
    await tunnel.start();
    await tunnel.dispose();

    await expect(tunnel.start()).rejects.toThrow(/disposed/);
    expect(tunnel.isActive).toBe(false);
  });
});
