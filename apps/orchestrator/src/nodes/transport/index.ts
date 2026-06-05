/**
 * NodeTransport public surface (US-7, US-8). The interface + error types, the
 * reusable contract suite, and BOTH implementations behind the same interface:
 *   - LocalTransport (US-7) — runs on the orchestrator host;
 *   - SshTransport (US-8) — runs over a managed ssh2 hop, supervised by
 *     SupervisedSshConnection (autossh-style auto-reconnect).
 */
export * from './transport.js';
export * from './local-transport.js';
export * from './ssh-transport.js';
export * from './ssh-connection.js';
export { runTransportContract } from './transport-contract.js';
export type { TransportFactory } from './transport-contract.js';
