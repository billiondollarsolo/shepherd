/**
 * sshTunnelHost — adapts a live ssh2 {@link Client} to the {@link TunnelHost}
 * seam {@link ReverseTunnel} programs against (US-9). This is the one place the
 * concrete ssh2 reverse-forward API (`forwardIn` / `unforwardIn` / the
 * `tcp connection` event) is touched, keeping ReverseTunnel itself
 * ssh2-agnostic and unit-testable with a fake host.
 *
 * It rides the SAME managed connection {@link SupervisedSshConnection} owns — no
 * second `ssh` process, no extra inbound port on the node (PRD §6.2). The node
 * stays a dumb courier: all tunnel logic is here on the orchestrator.
 */
import type { Client } from 'ssh2';

import type {
  ForwardedChannel,
  ForwardedConnectionInfo,
  TunnelHost,
} from './reverse-tunnel.js';

type TcpConnectionListener = (
  info: ForwardedConnectionInfo,
  accept: () => ForwardedChannel,
  reject: () => void,
) => void;

/**
 * Wrap a connected ssh2 {@link Client} as a {@link TunnelHost}. The returned
 * host does NOT own the client lifecycle (the supervised connection does);
 * canceling forwards / removing listeners on stop is the tunnel's job.
 */
export function sshTunnelHost(client: Client): TunnelHost {
  return {
    forwardIn(bindAddr, bindPort, callback) {
      // ssh2's Client.forwardIn returns the Client (chainable), not a
      // backpressure boolean; sending the global request always succeeds at this
      // layer (failures surface via the callback's err). Normalise to true so the
      // seam mirrors exec-style "request sent" semantics.
      client.forwardIn(bindAddr, bindPort, callback);
      return true;
    },
    unforwardIn(bindAddr, bindPort, callback) {
      // ssh2's Callback is (err?: Error | null); wrap to the seam's narrower
      // (err?: Error) shape so a null is coalesced to undefined.
      client.unforwardIn(bindAddr, bindPort, (err) => callback?.(err ?? undefined));
    },
    on(_event, listener) {
      client.on('tcp connection', listener as unknown as TcpConnectionListener);
      return this;
    },
    off(_event, listener) {
      client.off('tcp connection', listener as unknown as TcpConnectionListener);
      return this;
    },
  };
}
