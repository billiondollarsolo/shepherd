import {
  NODE_TOOL_CATALOG,
  nodeToolDefinition,
  type NodeCapabilitiesResponse,
  type NodeDockerCapability,
  type NodeInfo,
  type NodeToolCapability,
  type NodeToolId,
} from '@flock/shared';

import type { AgentdHost } from './agentd/ssh-agentd-host.js';

const ADMIN_HELPER = '/usr/local/sbin/flock-node-admin';
const PREPARATION_REASON =
  'Re-run the node-preparation script from this Shepherd release to enable managed installs.';

export class NodeCapabilityOperationError extends Error {
  constructor(
    readonly code:
      | 'node_unavailable'
      | 'preparation_outdated'
      | 'operation_failed'
      | 'operation_in_progress',
    message: string,
  ) {
    super(message);
    this.name = 'NodeCapabilityOperationError';
  }
}

/** Prevent package managers and node-level privilege changes from racing each other. */
export class NodeCapabilityOperationCoordinator {
  private readonly activeNodes = new Set<string>();

  async run<T>(nodeId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeNodes.has(nodeId)) {
      throw new NodeCapabilityOperationError(
        'operation_in_progress',
        'Another managed operation is already running on this node.',
      );
    }
    this.activeNodes.add(nodeId);
    try {
      return await operation();
    } finally {
      this.activeNodes.delete(nodeId);
    }
  }
}

function compact(value: string, fallback: string, limit = 2_000): string {
  const cleaned = value.replaceAll('\0', '').trim();
  if (!cleaned) return fallback;
  return cleaned.length <= limit ? cleaned : `…${cleaned.slice(-limit)}`;
}

interface DetectedTool {
  path: string;
  version: string;
}

export interface RemoteNodeInventory {
  tools: ReadonlyMap<string, DetectedTool>;
  dockerFields: ReadonlyMap<string, string>;
  toolManagementSupported: boolean;
  dockerManagementSupported: boolean;
  dockerInstallSupported: boolean;
}

function parseInventory(output: string): {
  tools: Map<string, DetectedTool>;
  dockerFields: Map<string, string>;
} {
  const tools = new Map<string, DetectedTool>();
  const dockerFields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [kind, name, value, ...remainder] = line.split('\t');
    if (kind === 'tool' && name && value) {
      tools.set(name, {
        path: value,
        version: remainder.join('\t').trim() || 'Version unavailable',
      });
    } else if (kind === 'docker' && name) {
      dockerFields.set(name, [value ?? '', ...remainder].join('\t').trim());
    }
  }
  return { tools, dockerFields };
}

function dockerFromFields(
  fields: Map<string, string>,
  managed: boolean,
  installSupported: boolean,
): NodeDockerCapability {
  const installed = fields.get('installed') === '1';
  const daemonRunning = fields.get('daemon') === '1';
  const agentAccess = fields.get('access') === '1';
  const reportedMode = fields.get('mode');
  const accessMode =
    agentAccess && reportedMode === 'rootless'
      ? ('rootless' as const)
      : agentAccess && reportedMode === 'system_acl'
        ? ('system_acl' as const)
        : agentAccess
          ? ('unmanaged' as const)
          : ('none' as const);
  let reason: string | null = null;
  if (!managed) reason = PREPARATION_REASON;
  else if (!installed && !installSupported)
    reason = 'Automatic Docker installation currently supports Debian and Ubuntu nodes.';
  else if (installed && !daemonRunning)
    reason = 'Docker is installed, but its daemon is not running.';
  return {
    installed,
    version: fields.get('version') || null,
    daemonRunning,
    agentAccess,
    accessMode,
    installSupported: managed && installSupported,
    accessManagementSupported: managed && installed,
    reason,
  };
}

async function helperCapabilities(host: AgentdHost): Promise<Set<string>> {
  const result = await host.exec(`timeout 10s sudo -n ${ADMIN_HELPER} capabilities`);
  return result.code === 0 ? new Set(result.stdout.trim().split(/\s+/)) : new Set();
}

function runtimeHelperCommand(command: string): string {
  const payload = Buffer.from(command, 'utf8').toString('base64');
  return `timeout --kill-after=5s 90s sudo -n ${ADMIN_HELPER} runtime-exec ${payload}`;
}

function directInventoryCommand(): string {
  const binaries = NODE_TOOL_CATALOG.map((tool) => tool.binary).join(' ');
  return runtimeHelperCommand(
    `for agent in ${binaries}; do bin=$(command -v "$agent" 2>/dev/null || true); if test -n "$bin"; then version=$(timeout 10s "$bin" --version 2>&1); status=$?; if test "$status" -eq 0; then version=$(printf '%s\\n' "$version" | head -n 1); test -n "$version" || version='version unavailable'; printf 'tool\\t%s\\t%s\\t%s\\n' "$agent" "$bin" "$version"; else printf 'tool\\t%s\\t\\t\\n' "$agent"; fi; else printf 'tool\\t%s\\t\\t\\n' "$agent"; fi; done; installed=0; version=''; daemon=0; access=0; mode=none; if command -v docker >/dev/null 2>&1; then installed=1; version=$(docker --version 2>/dev/null | head -n 1); if timeout 10s docker info >/dev/null 2>&1; then daemon=1; access=1; mode=unmanaged; fi; fi; printf 'docker\\tinstalled\\t%s\\ndocker\\tversion\\t%s\\ndocker\\tdaemon\\t%s\\ndocker\\taccess\\t%s\\ndocker\\tmode\\t%s\\ndocker\\tinstall_supported\\t0\\n' "$installed" "$version" "$daemon" "$access" "$mode"`,
  );
}

export async function inspectRemoteNodeInventory(host: AgentdHost): Promise<RemoteNodeInventory> {
  try {
    const helper = await helperCapabilities(host);
    const result = await host.exec(
      helper.has('inventory')
        ? `timeout --kill-after=5s 90s sudo -n ${ADMIN_HELPER} inventory`
        : directInventoryCommand(),
    );
    const parsed = result.code === 0 ? parseInventory(result.stdout) : parseInventory('');
    return {
      ...parsed,
      toolManagementSupported: helper.has('node-admin-v2') && helper.has('agents'),
      dockerManagementSupported: helper.has('node-admin-v2') && helper.has('docker'),
      dockerInstallSupported: parsed.dockerFields.get('install_supported') === '1',
    };
  } catch (error) {
    if (error instanceof NodeCapabilityOperationError) throw error;
    throw new NodeCapabilityOperationError(
      'node_unavailable',
      'The node capability inventory could not be read.',
    );
  }
}

export async function inspectRemoteNodeCapabilities(
  nodeId: string,
  host: AgentdHost,
): Promise<NodeCapabilitiesResponse> {
  const inventory = await inspectRemoteNodeInventory(host);
  const tools = NODE_TOOL_CATALOG.map((definition): NodeToolCapability => {
    const installed = inventory.tools.get(definition.binary);
    return {
      id: definition.id,
      agentType: definition.agentType,
      label: definition.label,
      binary: definition.binary,
      integration: definition.integration,
      installed: installed !== undefined,
      path: installed?.path ?? null,
      version: installed?.version ?? null,
      installSupported: inventory.toolManagementSupported,
      installReason: inventory.toolManagementSupported ? null : PREPARATION_REASON,
    };
  });
  return {
    nodeId,
    generatedAt: new Date().toISOString(),
    tools,
    docker: dockerFromFields(
      new Map(inventory.dockerFields),
      inventory.dockerManagementSupported,
      inventory.dockerInstallSupported,
    ),
  };
}

export function inspectLocalNodeCapabilities(
  nodeId: string,
  info: NodeInfo,
): NodeCapabilitiesResponse {
  const detected = new Map(info.agents.map((agent) => [agent.name, agent]));
  return {
    nodeId,
    generatedAt: new Date().toISOString(),
    tools: NODE_TOOL_CATALOG.map((definition) => {
      const agent = detected.get(definition.binary);
      return {
        id: definition.id,
        agentType: definition.agentType,
        label: definition.label,
        binary: definition.binary,
        integration: definition.integration,
        installed: agent !== undefined,
        path: agent?.path ?? null,
        version: agent?.version || null,
        installSupported: false,
        installReason:
          'The bundled local runtime is immutable; update Shepherd to change its bundled tools.',
      };
    }),
    docker: {
      installed: false,
      version: null,
      daemonRunning: false,
      agentAccess: false,
      accessMode: 'none',
      installSupported: false,
      accessManagementSupported: false,
      reason:
        'The bundled local runtime intentionally has no host Docker socket. Use a prepared remote node for Docker workloads.',
    },
  };
}

function boundedCommand(command: string): string {
  // Capture output on the node so verbose package managers cannot grow the
  // orchestrator process without bound. The helper command itself is fixed and
  // receives only schema-validated enum values.
  return `sh -c 'out=$(mktemp); trap "rm -f $out" EXIT HUP INT TERM; if timeout 600s ${command} >"$out" 2>&1; then code=0; else code=$?; fi; tail -c 16000 "$out"; exit $code'`;
}

export async function installRemoteNodeTool(
  nodeId: string,
  host: AgentdHost,
  tool: NodeToolId,
): Promise<{ capability: NodeToolCapability; summary: string }> {
  const helper = await helperCapabilities(host);
  if (!helper.has('node-admin-v2') || !helper.has('agents')) {
    throw new NodeCapabilityOperationError('preparation_outdated', PREPARATION_REASON);
  }
  const definition = nodeToolDefinition(tool);
  const result = await host.exec(
    boundedCommand(`sudo -n ${ADMIN_HELPER} install-agent ${definition.binary}`),
  );
  if (result.code !== 0) {
    throw new NodeCapabilityOperationError(
      'operation_failed',
      compact(result.stderr || result.stdout, `${definition.label} installation failed.`),
    );
  }
  const capabilities = await inspectRemoteNodeCapabilities(nodeId, host);
  const capability = capabilities.tools.find((candidate) => candidate.id === tool);
  if (!capability?.installed) {
    throw new NodeCapabilityOperationError(
      'operation_failed',
      `${definition.label} installer completed, but its executable could not be verified.`,
    );
  }
  return {
    capability,
    summary: compact(result.stdout, `${definition.label} ${capability.version ?? ''} is ready.`),
  };
}

export async function configureRemoteNodeDocker(
  nodeId: string,
  host: AgentdHost,
  action: 'install' | 'enable_agent_access' | 'disable_agent_access',
): Promise<{ docker: NodeDockerCapability; summary: string }> {
  const helper = await helperCapabilities(host);
  if (!helper.has('node-admin-v2') || !helper.has('docker')) {
    throw new NodeCapabilityOperationError('preparation_outdated', PREPARATION_REASON);
  }
  const operation =
    action === 'install'
      ? 'docker-install'
      : `docker-access ${action === 'enable_agent_access' ? 'enable' : 'disable'}`;
  const result = await host.exec(boundedCommand(`sudo -n ${ADMIN_HELPER} ${operation}`));
  if (result.code !== 0) {
    throw new NodeCapabilityOperationError(
      'operation_failed',
      compact(result.stderr || result.stdout, 'Docker configuration failed.'),
    );
  }
  const capabilities = await inspectRemoteNodeCapabilities(nodeId, host);
  return {
    docker: capabilities.docker,
    summary: compact(result.stdout, 'Docker configuration completed.'),
  };
}
