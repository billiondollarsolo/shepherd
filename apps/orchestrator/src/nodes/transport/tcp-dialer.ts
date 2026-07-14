import type { Duplex } from 'node:stream';
import type { NodeTransport } from './transport.js';

/** Transport capability used by the Remote Preview gateway. */
export interface NodeTcpDialer {
  /** Open a byte stream to loopback on the transport's node. */
  dialTcp(port: number, host?: '127.0.0.1' | '::1'): Promise<Duplex>;
}

export function hasNodeTcpDialer(
  transport: NodeTransport,
): transport is NodeTransport & NodeTcpDialer {
  return typeof (transport as Partial<NodeTcpDialer>).dialTcp === 'function';
}
