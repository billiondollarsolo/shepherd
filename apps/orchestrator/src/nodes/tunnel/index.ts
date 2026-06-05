/**
 * Reverse tunnel for hook callbacks (US-9). Public surface:
 *   - {@link ReverseTunnel} — the loopback-bound `ssh -R` tunnel over a managed
 *     SSH connection (NFR-SEC4: 127.0.0.1 bind, no GatewayPorts);
 *   - {@link sshTunnelHost} — adapts a live ssh2 Client to the TunnelHost seam;
 *   - the seam types so callers/tests can inject fakes.
 */
export {
  ReverseTunnel,
  TUNNEL_LOOPBACK_BIND_ADDRESS,
  type HookEndpointTarget,
  type HookDialer,
  type TunnelHost,
  type ForwardedChannel,
  type ForwardedConnectionInfo,
  type ReverseTunnelOptions,
} from './reverse-tunnel.js';
export { sshTunnelHost } from './ssh-tunnel-host.js';
