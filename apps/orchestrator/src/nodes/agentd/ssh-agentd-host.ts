/**
 * sshAgentdHost — adapts a live ssh2 {@link Client} to the {@link AgentdHost}
 * seam the flock-agentd remote path programs against. This is the ONE place the
 * concrete ssh2 outbound APIs the daemon needs are touched:
 *   - `forwardOut` — an SSH `direct-tcpip` channel to the daemon's loopback
 *     `--addr` on the node (no new inbound port; SSH carries authn+crypto), so
 *     the orchestrator's {@link NodeAgentdClient} rides the SAME managed
 *     connection {@link SupervisedSshConnection} owns;
 *   - `sftp` — upload the arch-matched daemon binary during bootstrap;
 *   - `exec` — probe arch/version and launch/supervise the daemon.
 *
 * Like {@link sshTunnelHost}, the returned host does NOT own the client lifecycle
 * (the supervised connection does); it just exposes capabilities over the live
 * link. Keeping ssh2 here leaves {@link AgentdBootstrap} / connection code
 * ssh2-agnostic and unit-testable against a fake host.
 */
import type { Duplex } from 'node:stream';

import type { Client } from 'ssh2';

/** Result of a one-shot remote command. */
export interface AgentdExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The low-level node capabilities the agentd remote path needs, decoupled from
 * ssh2 so the bootstrap/connection logic is testable with a fake.
 */
export interface AgentdHost {
  /**
   * Open an SSH direct-tcpip channel to `host:port` on the node (loopback → the
   * daemon's `--addr`). Resolves to a Duplex carrying the framed agentd protocol.
   */
  forwardOut(host: string, port: number): Promise<Duplex>;
  /** Upload a local file to the node and chmod it (mode default 0o700). */
  uploadFile(localPath: string, remotePath: string, mode?: number): Promise<void>;
  /** Run a one-shot command on the node, capturing stdout/stderr/exit code. */
  exec(command: string): Promise<AgentdExecResult>;
}

/** Wrap a connected ssh2 {@link Client} as an {@link AgentdHost}. */
export function sshAgentdHost(client: Client): AgentdHost {
  return {
    forwardOut(host, port) {
      return new Promise<Duplex>((resolve, reject) => {
        // srcIP/srcPort are advisory for direct-tcpip; loopback/0 is conventional.
        client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
          if (err) reject(err);
          else resolve(channel);
        });
      });
    },
    uploadFile(localPath, remotePath, mode = 0o700) {
      return new Promise<void>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err);
          sftp.fastPut(localPath, remotePath, (putErr) => {
            if (putErr) {
              sftp.end();
              return reject(putErr);
            }
            sftp.chmod(remotePath, mode, (chmodErr) => {
              sftp.end();
              if (chmodErr) reject(chmodErr);
              else resolve();
            });
          });
        });
      });
    },
    exec(command) {
      return new Promise<AgentdExecResult>((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err);
          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          });
          stream.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
          stream.on('close', (code: number | null) => {
            resolve({ code, stdout, stderr });
          });
          stream.on('error', reject);
        });
      });
    },
  };
}
