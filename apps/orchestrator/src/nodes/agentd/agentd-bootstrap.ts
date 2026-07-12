/**
 * Secure remote agentd enrollment and upgrade over the already pinned SSH link.
 * Agentd is a root-owned system service; every child is dropped to the dedicated
 * unprivileged `flock-agent` account. There is deliberately no user-service/nohup
 * fallback because that would collapse the control/runtime security boundary.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentdCompatibility } from '@flock/shared';

import type { AgentdHost } from './ssh-agentd-host.js';
import type { NodeControlIdentity } from './node-control-credentials.js';
import {
  evaluateAgentdCompatibility,
  type ResolvedAgentdCompatibilityPolicy,
} from './agentd-compatibility.js';

export interface AgentdPlatform {
  os: string;
  arch: string;
}

export interface AgentdBinaryProvider {
  resolve(platform: AgentdPlatform): Promise<string>;
}

export interface AgentdBootstrapConfig {
  version: string;
  compatibilityPolicy?: ResolvedAgentdCompatibilityPolicy;
  port: number;
  binaries: AgentdBinaryProvider;
  logger?: { warn(msg: string): void };
  onEvent?: (
    nodeId: string,
    event: 'installed' | 'upgraded' | 'service_started' | 'rolled_back',
  ) => void;
}

export interface AgentdEndpoint {
  host: string;
  port: number;
}

export interface AgentdInstallState {
  installedVersion: string;
  expectedVersion: string;
  running: boolean;
  servicePrepared: boolean;
  binaryUpgradeRequired: boolean;
  upgradeRequired: boolean;
  compatibility: AgentdCompatibility;
}

const SYSTEM_BIN = '/usr/local/lib/flock-agentd/flock-agentd';
const ADMIN_HELPER = '/usr/local/sbin/flock-node-admin';

export class AgentdBootstrap {
  private readonly version: string;
  private readonly compatibilityPolicy: ResolvedAgentdCompatibilityPolicy;
  private readonly port: number;
  private readonly binaries: AgentdBinaryProvider;
  private readonly logger: { warn(msg: string): void };
  private readonly onEvent?: AgentdBootstrapConfig['onEvent'];

  constructor(cfg: AgentdBootstrapConfig) {
    this.version = cfg.version;
    this.compatibilityPolicy = cfg.compatibilityPolicy ?? {
      schemaVersion: 1,
      preferredDaemonVersion: cfg.version,
      minimumDaemonVersion: cfg.version,
      preferredProtocolVersion: 2,
      supportedProtocolVersions: [2],
      requiredCapabilities: ['pty'],
      supportWindow: { minorReleases: 1, minimumDays: 90 },
    };
    this.port = cfg.port;
    this.binaries = cfg.binaries;
    this.logger = cfg.logger ?? {
      warn(msg) {
        // eslint-disable-next-line no-console
        console.warn(`[agentd-bootstrap] ${msg}`);
      },
    };
    this.onEvent = cfg.onEvent;
  }

  async ensureRunning(
    host: AgentdHost,
    identity: NodeControlIdentity,
    options: { forceBinaryReplacement?: boolean } = {},
  ): Promise<AgentdEndpoint> {
    if (identity.credential.length < 32) {
      throw new Error('agentd: a per-node credential of at least 32 characters is required');
    }
    const [installed, servicePrepared] = await Promise.all([
      this.installedVersion(host),
      this.servicePrepared(host, identity.nodeId),
    ]);
    const compatibility = evaluateAgentdCompatibility(this.compatibilityPolicy, {
      installedVersion: installed,
      servicePrepared,
    });
    const binaryUpgradeRequired =
      compatibility.binaryReplacement || options.forceBinaryReplacement === true;
    if (binaryUpgradeRequired) {
      const platform = await this.detectPlatform(host);
      const local = await this.binaries.resolve(platform);
      await this.installBinary(host, local, platform);
      this.onEvent?.(identity.nodeId, installed ? 'upgraded' : 'installed');
    }
    const running = await this.isListening(host);
    if (binaryUpgradeRequired || !running || !servicePrepared) {
      await this.installCredential(host, identity.credential);
      await this.installAndStartService(host, identity.nodeId, binaryUpgradeRequired);
      this.onEvent?.(identity.nodeId, 'service_started');
    }
    return { host: '127.0.0.1', port: this.port };
  }

  /** Read-only rollout state used to decide whether an active daemon may be upgraded. */
  async inspect(host: AgentdHost, nodeId?: string): Promise<AgentdInstallState> {
    const [installedVersion, running, servicePrepared] = await Promise.all([
      this.installedVersion(host),
      this.isListening(host),
      nodeId ? this.servicePrepared(host, nodeId) : Promise.resolve(true),
    ]);
    const compatibility = evaluateAgentdCompatibility(this.compatibilityPolicy, {
      installedVersion,
      servicePrepared,
    });
    return {
      installedVersion,
      expectedVersion: this.version,
      running,
      servicePrepared,
      binaryUpgradeRequired: compatibility.binaryReplacement,
      upgradeRequired: compatibility.binaryReplacement || !servicePrepared,
      compatibility,
    };
  }

  endpoint(): AgentdEndpoint {
    return { host: '127.0.0.1', port: this.port };
  }

  policy(): ResolvedAgentdCompatibilityPolicy {
    return {
      ...this.compatibilityPolicy,
      supportedProtocolVersions: [...this.compatibilityPolicy.supportedProtocolVersions],
      requiredCapabilities: [...this.compatibilityPolicy.requiredCapabilities],
    };
  }

  /** Restore the retained daemon and re-activate it after post-start validation fails. */
  async rollback(host: AgentdHost, nodeId: string): Promise<void> {
    await this.run(host, `sudo -n ${ADMIN_HELPER} rollback`);
    this.onEvent?.(nodeId, 'rolled_back');
  }

  private async isListening(host: AgentdHost): Promise<boolean> {
    try {
      const channel = await host.forwardOut('127.0.0.1', this.port);
      channel.destroy();
      return true;
    } catch {
      return false;
    }
  }

  private async detectPlatform(host: AgentdHost): Promise<AgentdPlatform> {
    const result = await host.exec('uname -s; uname -m');
    const [rawOs = '', rawArch = ''] = result.stdout.trim().split('\n');
    const os = rawOs.trim().toLowerCase();
    const arch = normalizeArch(rawArch.trim());
    if (os !== 'linux' || !arch) {
      throw new Error(
        `agentd: unsupported node platform (uname: ${JSON.stringify(result.stdout)})`,
      );
    }
    return { os, arch };
  }

  private async installedVersion(host: AgentdHost): Promise<string> {
    try {
      const result = await host.exec(`${SYSTEM_BIN} version 2>/dev/null`);
      return result.code === 0 ? result.stdout.trim() : '';
    } catch {
      return '';
    }
  }

  private async servicePrepared(host: AgentdHost, nodeId: string): Promise<boolean> {
    try {
      const result = await host.exec(
        `sudo -n ${ADMIN_HELPER} service-status ${shq(nodeId)} ${this.port}`,
      );
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async remoteHome(host: AgentdHost): Promise<string> {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim();
    if (!home) throw new Error('agentd: could not resolve the remote account home');
    return home;
  }

  private async installBinary(
    host: AgentdHost,
    localPath: string,
    platform: AgentdPlatform,
  ): Promise<void> {
    const bytes = await readFile(localPath);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const remoteTmp = `${await this.remoteHome(host)}/.flock-agentd-binary.new`;
    const manifest = Buffer.from(
      JSON.stringify({
        version: this.version,
        checksum,
        architecture: `${platform.os}/${platform.arch}`,
        installedAt: new Date().toISOString(),
      }),
      'utf8',
    ).toString('base64');
    await host.uploadFile(localPath, remoteTmp, 0o700);
    await this.run(
      host,
      `sudo -n ${ADMIN_HELPER} install-binary ${shq(remoteTmp)} ${shq(checksum)} ${shq(manifest)}`,
    );
  }

  /** Upload the secret as file content; it never appears in a remote command. */
  private async installCredential(host: AgentdHost, credential: string): Promise<void> {
    const localDir = await mkdtemp(path.join(tmpdir(), 'flock-agentd-credential-'));
    const localPath = path.join(localDir, 'control.key');
    const remotePath = `${await this.remoteHome(host)}/.flock-agentd-control.new`;
    try {
      await writeFile(localPath, `${credential}\n`, { mode: 0o600 });
      await host.uploadFile(localPath, remotePath, 0o600);
      await this.run(host, `sudo -n ${ADMIN_HELPER} install-credential ${shq(remotePath)}`);
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  }

  private async installAndStartService(
    host: AgentdHost,
    nodeId: string,
    binaryUpgradeRequired: boolean,
  ): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nodeId)) {
      throw new Error('agentd: invalid node identity');
    }
    const script = [
      `sudo -n ${ADMIN_HELPER} install-service ${shq(nodeId)} ${this.port}`,
      `sudo -n ${ADMIN_HELPER} restart ${binaryUpgradeRequired ? 'candidate' : 'service'}`,
    ].join('\n');
    const result = await host.exec(script);
    if (result.code !== 0) {
      this.logger.warn(
        `secure system-service enrollment exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
      throw new Error(`agentd: secure system-service enrollment failed (code ${result.code})`);
    }
  }

  private async run(host: AgentdHost, command: string): Promise<void> {
    const result = await host.exec(command);
    if (result.code !== 0) {
      throw new Error(
        `agentd: remote command failed (code ${result.code}): ${command}\n${result.stderr.trim()}`,
      );
    }
  }
}

function normalizeArch(machine: string): string {
  switch (machine) {
    case 'x86_64':
    case 'amd64':
      return 'amd64';
    case 'aarch64':
    case 'arm64':
      return 'arm64';
    default:
      return '';
  }
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
