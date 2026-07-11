/**
 * Secure remote agentd enrollment and upgrade over the already pinned SSH link.
 * Agentd is a root-owned system service; every child is dropped to the dedicated
 * non-login `flock-agent` account. There is deliberately no user-service/nohup
 * fallback because that would collapse the control/runtime security boundary.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentdHost } from './ssh-agentd-host.js';
import type { NodeControlIdentity } from './node-control-credentials.js';

export interface AgentdPlatform {
  os: string;
  arch: string;
}

export interface AgentdBinaryProvider {
  resolve(platform: AgentdPlatform): Promise<string>;
}

export interface AgentdBootstrapConfig {
  version: string;
  port: number;
  binaries: AgentdBinaryProvider;
  runtimeUser?: string;
  logger?: { warn(msg: string): void };
  onEvent?: (nodeId: string, event: 'installed' | 'upgraded' | 'service_started') => void;
}

export interface AgentdEndpoint {
  host: string;
  port: number;
}

const SYSTEM_BIN = '/usr/local/lib/flock-agentd/flock-agentd';
const PREVIOUS_BIN = '/usr/local/lib/flock-agentd/flock-agentd.previous';
const CREDENTIAL_FILE = '/etc/flock-agentd/control.key';
const STATE_DIR = '/var/lib/flock-agentd';
const SERVICE_FILE = '/etc/systemd/system/flock-agentd.service';

export class AgentdBootstrap {
  private readonly version: string;
  private readonly port: number;
  private readonly binaries: AgentdBinaryProvider;
  private readonly runtimeUser: string;
  private readonly logger: { warn(msg: string): void };
  private readonly onEvent?: AgentdBootstrapConfig['onEvent'];

  constructor(cfg: AgentdBootstrapConfig) {
    this.version = cfg.version;
    this.port = cfg.port;
    this.binaries = cfg.binaries;
    this.runtimeUser = cfg.runtimeUser ?? 'flock-agent';
    this.logger = cfg.logger ?? {
      warn(msg) {
        // eslint-disable-next-line no-console
        console.warn(`[agentd-bootstrap] ${msg}`);
      },
    };
    this.onEvent = cfg.onEvent;
  }

  async ensureRunning(host: AgentdHost, identity: NodeControlIdentity): Promise<AgentdEndpoint> {
    if (identity.credential.length < 32) {
      throw new Error('agentd: a per-node credential of at least 32 characters is required');
    }
    const installed = await this.installedVersion(host);
    const upgraded = installed !== this.version;
    if (upgraded) {
      const platform = await this.detectPlatform(host);
      const local = await this.binaries.resolve(platform);
      await this.installBinary(host, local, platform);
      this.onEvent?.(identity.nodeId, installed ? 'upgraded' : 'installed');
    }
    const running = await this.isListening(host);
    if (upgraded || !running) {
      await this.installCredential(host, identity.credential);
      await this.installAndStartService(host, identity.nodeId);
      this.onEvent?.(identity.nodeId, 'service_started');
    }
    return { host: '127.0.0.1', port: this.port };
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
    await host.uploadFile(localPath, remoteTmp, 0o700);
    await this.run(
      host,
      [
        'set -e',
        'sudo -n true',
        `test "$(sha256sum ${shq(remoteTmp)} | awk '{print $1}')" = ${shq(checksum)}`,
        'sudo -n install -d -o root -g root -m 0755 /usr/local/lib/flock-agentd',
        `sudo -n install -d -o root -g root -m 0750 ${STATE_DIR}`,
        `if sudo -n test -x ${SYSTEM_BIN}; then sudo -n cp -f ${SYSTEM_BIN} ${PREVIOUS_BIN}; fi`,
        `sudo -n install -o root -g root -m 0755 ${shq(remoteTmp)} ${SYSTEM_BIN}`,
        `rm -f ${shq(remoteTmp)}`,
        `printf '%s\n' ${shq(
          JSON.stringify({
            version: this.version,
            checksum,
            architecture: `${platform.os}/${platform.arch}`,
            installedAt: new Date().toISOString(),
          }),
        )} | sudo -n tee ${STATE_DIR}/install.json >/dev/null`,
        `sudo -n chmod 0644 ${STATE_DIR}/install.json`,
      ].join('\n'),
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
      await this.run(
        host,
        [
          'set -e',
          'sudo -n true',
          'sudo -n install -d -o root -g root -m 0700 /etc/flock-agentd',
          `sudo -n install -o root -g root -m 0400 ${shq(remotePath)} ${CREDENTIAL_FILE}`,
          `rm -f ${shq(remotePath)}`,
        ].join('\n'),
      );
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  }

  private serviceUnit(nodeId: string): string {
    return [
      '[Unit]',
      'Description=Flock privilege-separated agent daemon',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'Group=root',
      `ExecStart=${SYSTEM_BIN} serve --socket '' --addr 127.0.0.1:${this.port} --state-dir ${STATE_DIR}/state --secret-file ${CREDENTIAL_FILE} --node-id ${nodeId} --runtime-user ${this.runtimeUser}`,
      'Restart=always',
      'RestartSec=2',
      'NoNewPrivileges=true',
      'PrivateDevices=false',
      'PrivateTmp=false',
      'ProtectClock=true',
      'ProtectControlGroups=true',
      'ProtectKernelLogs=true',
      'ProtectKernelModules=true',
      'ProtectKernelTunables=true',
      'ProtectSystem=strict',
      'ReadWritePaths=/var/lib/flock-agentd /tmp /home',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_SETGID CAP_SETUID',
      'LimitNOFILE=8192',
      'TasksMax=4096',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
  }

  private async installAndStartService(host: AgentdHost, nodeId: string): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nodeId)) {
      throw new Error('agentd: invalid node identity');
    }
    const unit = Buffer.from(this.serviceUnit(nodeId), 'utf8').toString('base64');
    const script = [
      'set -e',
      'sudo -n true',
      `id -u ${this.runtimeUser} >/dev/null 2>&1 || sudo -n useradd --system --create-home --shell /bin/bash ${this.runtimeUser}`,
      `sudo -n install -d -o root -g root -m 0750 ${STATE_DIR} ${STATE_DIR}/state`,
      `printf %s ${shq(unit)} | base64 -d | sudo -n tee ${SERVICE_FILE} >/dev/null`,
      `sudo -n chown root:root ${SERVICE_FILE}`,
      `sudo -n chmod 0644 ${SERVICE_FILE}`,
      'sudo -n systemctl daemon-reload',
      'sudo -n systemctl enable flock-agentd.service >/dev/null',
      'if ! sudo -n systemctl restart flock-agentd.service; then',
      `  if sudo -n test -x ${PREVIOUS_BIN}; then sudo -n cp -f ${PREVIOUS_BIN} ${SYSTEM_BIN}; sudo -n systemctl restart flock-agentd.service; fi`,
      '  exit 1',
      'fi',
      'i=0',
      'while ! sudo -n systemctl is-active --quiet flock-agentd.service; do',
      '  i=$((i + 1))',
      '  if [ "$i" -ge 20 ]; then',
      `    if sudo -n test -x ${PREVIOUS_BIN}; then sudo -n cp -f ${PREVIOUS_BIN} ${SYSTEM_BIN}; sudo -n systemctl restart flock-agentd.service; fi`,
      '    exit 1',
      '  fi',
      '  sleep 0.25',
      'done',
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
