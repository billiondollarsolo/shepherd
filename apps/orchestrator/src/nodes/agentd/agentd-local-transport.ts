import type { Duplex } from 'node:stream';

import type { AgentdConnections } from './agentd-connections.js';
import type { ExecOptions, ExecResult, NodeCommandTransport } from '../transport/transport.js';
import { TransportDisposedError, TransportInvalidCommandError } from '../transport/transport.js';

/**
 * Node operations for the bundled local runtime. Every operation opens a fresh
 * mutually authenticated agentd connection, so commands and Preview bytes run
 * in the runtime namespace without sharing the long-lived PTY/status link.
 */
export class AgentdLocalTransport implements NodeCommandTransport {
  readonly kind = 'local' as const;
  private disposed = false;

  constructor(
    private readonly connections: AgentdConnections,
    private readonly nodeId: () => string,
  ) {}

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.assertOpen();
    if (command.length === 0) throw new TransportInvalidCommandError();
    return await this.connections.execLocal(this.requireNodeId(), {
      command,
      cwd: options.cwd,
      env: options.env
        ? Object.entries(options.env)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .map(([key, value]) => `${key}=${value}`)
        : undefined,
      input: options.input,
      timeoutMs: options.timeoutMs,
    });
  }

  async dialTcp(port: number, host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<Duplex> {
    this.assertOpen();
    return await this.connections.dialLocalTcp(this.requireNodeId(), port, host);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) throw new TransportDisposedError(this.kind);
  }

  private requireNodeId(): string {
    const id = this.nodeId();
    if (!id) throw new Error('The local runtime node identity is not initialized.');
    return id;
  }
}
