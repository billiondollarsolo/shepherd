import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { NODE_TOOL_CATALOG } from '@flock/shared';

import type { AgentdExecResult, AgentdHost } from './agentd/ssh-agentd-host.js';
import {
  NodeCapabilityOperationCoordinator,
  NodeCapabilityOperationError,
  configureRemoteNodeDocker,
  inspectLocalNodeCapabilities,
  inspectRemoteNodeCapabilities,
  installRemoteNodeTool,
} from './node-capabilities.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';

function inventoryOutput(
  options: {
    installed?: boolean;
    daemonRunning?: boolean;
    agentAccess?: boolean;
    mode?: string;
    installSupported?: boolean;
  } = {},
): string {
  const installed = options.installed ?? true;
  const daemonRunning = options.daemonRunning ?? true;
  const agentAccess = options.agentAccess ?? false;
  const mode = options.mode ?? (agentAccess ? 'system_acl' : 'none');
  const installSupported = options.installSupported ?? true;
  const tools = NODE_TOOL_CATALOG.map(
    (tool) =>
      `tool\t${tool.binary}\t/home/flock-agent/.local/bin/${tool.binary}\t${tool.binary} 1.2.3`,
  ).join('\n');
  return `${tools}\ndocker\tinstalled\t${installed ? '1' : '0'}\ndocker\tversion\t${installed ? 'Docker version 29.1.3' : ''}\ndocker\tdaemon\t${daemonRunning ? '1' : '0'}\ndocker\taccess\t${agentAccess ? '1' : '0'}\ndocker\tmode\t${mode}\ndocker\tinstall_supported\t${installSupported ? '1' : '0'}\n`;
}

class Host implements AgentdHost {
  readonly commands: string[] = [];
  constructor(private readonly run: (command: string) => Partial<AgentdExecResult>) {}
  async exec(command: string): Promise<AgentdExecResult> {
    this.commands.push(command);
    return { code: 0, stdout: '', stderr: '', ...this.run(command) };
  }
  async uploadFile(): Promise<void> {}
  async forwardOut() {
    return new PassThrough();
  }
}

function managedHost(overrides?: (command: string) => Partial<AgentdExecResult> | undefined): Host {
  return new Host((command) => {
    const override = overrides?.(command);
    if (override) return override;
    if (command.endsWith(' capabilities')) {
      return { stdout: 'node-admin-v2 agents docker inventory\n' };
    }
    if (command.includes('/etc/os-release')) return { code: 0 };
    if (command.endsWith(' inventory')) return { stdout: inventoryOutput() };
    if (command.includes(' runtime-exec ')) {
      const payload = command.split(' runtime-exec ')[1]!.trim();
      const decoded = Buffer.from(payload, 'base64').toString('utf8');
      if (decoded.includes("printf 'tool\\t%s")) {
        return { stdout: inventoryOutput({ agentAccess: true }) };
      }
    }
    if (command.includes(' install-agent ') || command.includes(' docker-access enable')) {
      return { stdout: 'operation complete\n' };
    }
    return {};
  });
}

describe('node managed capabilities', () => {
  it('reports every launchable CLI and Docker independently', async () => {
    const host = managedHost();
    const result = await inspectRemoteNodeCapabilities(NODE_ID, host);

    expect(result.tools.map((tool) => tool.id)).toEqual(NODE_TOOL_CATALOG.map((tool) => tool.id));
    expect(result.tools.filter((tool) => tool.integration === 'first_class')).toHaveLength(5);
    expect(result.tools.filter((tool) => tool.integration === 'basic')).toHaveLength(3);
    expect(result.docker).toMatchObject({
      installed: true,
      daemonRunning: true,
      agentAccess: false,
      installSupported: true,
      accessManagementSupported: true,
    });
    expect(host.commands).toHaveLength(2);
  });

  it('detects tools but refuses managed writes through an old node helper', async () => {
    const host = managedHost((command) =>
      command.endsWith(' capabilities') ? { code: 1, stderr: 'unsupported operation' } : undefined,
    );
    const result = await inspectRemoteNodeCapabilities(NODE_ID, host);

    expect(result.tools.every((tool) => tool.installed)).toBe(true);
    expect(result.tools.find((tool) => tool.id === 'amp')).toMatchObject({ installed: true });
    expect(result.tools.every((tool) => !tool.installSupported)).toBe(true);
    await expect(installRemoteNodeTool(NODE_ID, host, 'amp')).rejects.toMatchObject({
      code: 'preparation_outdated',
    } satisfies Partial<NodeCapabilityOperationError>);
  });

  it('installs only a schema-selected tool and verifies it afterward', async () => {
    const host = managedHost();
    const result = await installRemoteNodeTool(NODE_ID, host, 'amp');

    expect(result.capability).toMatchObject({ id: 'amp', installed: true });
    expect(host.commands.some((command) => command.includes('install-agent amp'))).toBe(true);
  });

  it('enables Docker access through the bounded helper and re-reads status', async () => {
    let enabled = false;
    const host = managedHost((command) => {
      if (command.includes(' docker-access enable')) {
        enabled = true;
        return { stdout: 'enabled\n' };
      }
      if (command.endsWith(' inventory') && enabled) {
        return { stdout: inventoryOutput({ agentAccess: true }) };
      }
      return undefined;
    });
    const result = await configureRemoteNodeDocker(NODE_ID, host, 'enable_agent_access');

    expect(result.docker).toMatchObject({ agentAccess: true, accessMode: 'system_acl' });
  });

  it('maps each Docker action and surfaces bounded helper failures', async () => {
    const installHost = managedHost();
    await configureRemoteNodeDocker(NODE_ID, installHost, 'install');
    expect(installHost.commands.some((command) => command.includes(' docker-install'))).toBe(true);

    const disableHost = managedHost();
    await configureRemoteNodeDocker(NODE_ID, disableHost, 'disable_agent_access');
    expect(disableHost.commands.some((command) => command.includes('docker-access disable'))).toBe(
      true,
    );

    const failedHost = managedHost((command) =>
      command.includes(' docker-install')
        ? { code: 1, stderr: 'package installation failed' }
        : undefined,
    );
    await expect(configureRemoteNodeDocker(NODE_ID, failedHost, 'install')).rejects.toMatchObject({
      code: 'operation_failed',
      message: 'package installation failed',
    } satisfies Partial<NodeCapabilityOperationError>);
  });

  it('describes rootless, unmanaged, stopped, and unsupported Docker states', async () => {
    const inspectDocker = async (output: string) =>
      (
        await inspectRemoteNodeCapabilities(
          NODE_ID,
          managedHost((command) =>
            command.endsWith(' inventory') ? { stdout: output } : undefined,
          ),
        )
      ).docker;

    await expect(
      inspectDocker(inventoryOutput({ agentAccess: true, mode: 'rootless' })),
    ).resolves.toMatchObject({ accessMode: 'rootless', reason: null });
    await expect(
      inspectDocker(inventoryOutput({ agentAccess: true, mode: 'external' })),
    ).resolves.toMatchObject({ accessMode: 'unmanaged', reason: null });
    await expect(inspectDocker(inventoryOutput({ daemonRunning: false }))).resolves.toMatchObject({
      installed: true,
      daemonRunning: false,
      reason: 'Docker is installed, but its daemon is not running.',
    });
    await expect(
      inspectDocker(inventoryOutput({ installed: false, installSupported: false })),
    ).resolves.toMatchObject({
      installed: false,
      installSupported: false,
      reason: 'Automatic Docker installation currently supports Debian and Ubuntu nodes.',
    });
  });

  it('reports immutable local-runtime tools without pretending to manage them', () => {
    const result = inspectLocalNodeCapabilities(NODE_ID, {
      hostname: 'local-runtime',
      os: 'linux',
      kernel: '6.8',
      cores: 4,
      uptimeSec: 10,
      load1: 0,
      load5: 0,
      load15: 0,
      cpuPercent: 0,
      memTotal: 1024,
      memUsed: 512,
      diskTotal: 2048,
      diskUsed: 1024,
      agents: [{ name: 'amp', path: '/usr/local/bin/amp', version: '' }],
    });

    expect(result.tools.find((tool) => tool.id === 'amp')).toMatchObject({
      installed: true,
      version: null,
      installSupported: false,
    });
    expect(result.tools.find((tool) => tool.id === 'claude')).toMatchObject({ installed: false });
    expect(result.docker).toMatchObject({ installed: false, accessMode: 'none' });
  });

  it('serializes node mutations and always releases the node after failure', async () => {
    const coordinator = new NodeCapabilityOperationCoordinator();
    let release!: () => void;
    const first = coordinator.run(
      NODE_ID,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await expect(coordinator.run(NODE_ID, async () => undefined)).rejects.toMatchObject({
      code: 'operation_in_progress',
    } satisfies Partial<NodeCapabilityOperationError>);
    release();
    await first;
    await expect(
      coordinator.run(NODE_ID, async () => {
        throw new Error('failed operation');
      }),
    ).rejects.toThrow('failed operation');
    await expect(coordinator.run(NODE_ID, async () => 'ready')).resolves.toBe('ready');
  });
});
