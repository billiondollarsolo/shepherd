import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { NODE_TOOL_CATALOG } from '@flock/shared';

import type { AgentdExecResult, AgentdHost } from './agentd/ssh-agentd-host.js';
import {
  NodeCapabilityOperationCoordinator,
  NodeCapabilityOperationError,
  configureRemoteNodeDocker,
  inspectRemoteNodeCapabilities,
  installRemoteNodeTool,
} from './node-capabilities.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';

function inventoryOutput(agentAccess = false): string {
  const tools = NODE_TOOL_CATALOG.map(
    (tool) =>
      `tool\t${tool.binary}\t/home/flock-agent/.local/bin/${tool.binary}\t${tool.binary} 1.2.3`,
  ).join('\n');
  return `${tools}\ndocker\tinstalled\t1\ndocker\tversion\tDocker version 29.1.3\ndocker\tdaemon\t1\ndocker\taccess\t${agentAccess ? '1' : '0'}\ndocker\tmode\t${agentAccess ? 'system_acl' : 'none'}\ndocker\tinstall_supported\t1\n`;
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
      if (decoded.includes("printf 'tool\\t%s")) return { stdout: inventoryOutput(true) };
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
      if (command.endsWith(' inventory') && enabled) return { stdout: inventoryOutput(true) };
      return undefined;
    });
    const result = await configureRemoteNodeDocker(NODE_ID, host, 'enable_agent_access');

    expect(result.docker).toMatchObject({ agentAccess: true, accessMode: 'system_acl' });
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
    await expect(coordinator.run(NODE_ID, async () => 'ready')).resolves.toBe('ready');
  });
});
