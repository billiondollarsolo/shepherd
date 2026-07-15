import {
  NODE_TOOL_CATALOG,
  type AgentdCompatibility,
  type NodePreflightCheck,
  type NodePreflightResponse,
} from '@flock/shared';

import type { AgentdHost } from './agentd/ssh-agentd-host.js';
import {
  evaluateAgentdCompatibility,
  type ResolvedAgentdCompatibilityPolicy,
} from './agentd/agentd-compatibility.js';
import { inspectRemoteNodeInventory } from './node-capabilities.js';

const ADMIN_HELPER = '/usr/local/sbin/flock-node-admin';
const SYSTEM_BIN = '/usr/local/lib/flock-agentd/flock-agentd';

export interface RemoteNodePreflightInput {
  nodeId: string;
  host: AgentdHost;
  compatibilityPolicy: ResolvedAgentdCompatibilityPolicy;
  authenticatedCompatibility?: AgentdCompatibility | null;
  workspaces: readonly string[];
}

function check(
  id: string,
  label: string,
  status: NodePreflightCheck['status'],
  detail: string,
): NodePreflightCheck {
  return { id, label, status, detail };
}

function compact(value: string, fallback: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 240) || fallback;
}

/**
 * Proves that the SSH target is prepared for Shepherd without mutating it. Commands
 * are deliberately narrow and the root-side helper validates workspace/tool args.
 */
export async function preflightRemoteNode(
  input: RemoteNodePreflightInput,
): Promise<NodePreflightResponse> {
  const checks: NodePreflightCheck[] = [];
  // SSH servers commonly cap multiplexed sessions at ten. Keep this diagnostic
  // read path sequential so opening Node details alongside Git and stack probes
  // cannot exhaust the shared control connection.
  const platform = await input.host.exec('uname -s; uname -m');
  const prepared = await input.host.exec(`sudo -n ${ADMIN_HELPER} preflight`);
  const installed = await input.host.exec(`${SYSTEM_BIN} version 2>/dev/null`);
  const disk = await input.host.exec("df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}'");
  const forwarding = await input.host
    .forwardOut('127.0.0.1', 22)
    .then((channel) => {
      channel.destroy();
      return true;
    })
    .catch(() => false);
  const [os = '', arch = ''] = platform.stdout.trim().split('\n');
  const supportedArch = ['x86_64', 'amd64', 'aarch64', 'arm64'].includes(arch.trim());
  checks.push(
    check(
      'platform',
      'Supported platform',
      platform.code === 0 && os.trim() === 'Linux' && supportedArch ? 'pass' : 'fail',
      platform.code === 0 ? `${os.trim()} ${arch.trim()}` : 'Could not inspect the host platform.',
    ),
  );
  checks.push(
    check(
      'ssh-forwarding',
      'SSH forwarding',
      forwarding ? 'pass' : 'fail',
      forwarding
        ? 'SSH direct-tcpip forwarding is available.'
        : 'Enable SSH AllowTcpForwarding for the control account.',
    ),
  );
  const freeKiB = Number.parseInt(disk.stdout.trim(), 10);
  const minimumKiB = 512 * 1024;
  checks.push(
    check(
      'disk-space',
      'Installation disk space',
      disk.code === 0 && Number.isFinite(freeKiB) && freeKiB >= minimumKiB ? 'pass' : 'fail',
      Number.isFinite(freeKiB)
        ? `${Math.max(0, freeKiB / 1024 / 1024).toFixed(1)} GiB free under /var/lib.`
        : 'Could not determine free space under /var/lib.',
    ),
  );

  checks.push(
    check(
      'preparation',
      'Shepherd node preparation',
      prepared.code === 0 ? 'pass' : 'fail',
      prepared.code === 0
        ? compact(prepared.stdout, 'Prepared identities and constrained administrator are ready.')
        : compact(
            prepared.stderr || prepared.stdout,
            'Run scripts/flock-node-prepare.sh on this host before enrollment.',
          ),
    ),
  );

  const installedVersion = installed.code === 0 ? installed.stdout.trim() : '';
  const daemonCompatibility =
    input.authenticatedCompatibility ??
    evaluateAgentdCompatibility(input.compatibilityPolicy, {
      installedVersion,
      servicePrepared: prepared.code === 0,
    });
  checks.push(
    check(
      'daemon-version',
      'Node daemon',
      daemonCompatibility.state === 'compatible'
        ? 'pass'
        : daemonCompatibility.state === 'recommended'
          ? 'warning'
          : 'fail',
      daemonCompatibility.detail,
    ),
  );

  for (const workspace of [...new Set(input.workspaces)].sort()) {
    const result = await input.host.exec(
      `sudo -n ${ADMIN_HELPER} check-workspace ${shellQuote(workspace)}`,
    );
    checks.push(
      check(
        `workspace:${workspace}`,
        'Runtime workspace access',
        result.code === 0 ? 'pass' : 'fail',
        result.code === 0
          ? `${workspace} is readable and writable by flock-agent.`
          : `${workspace} is not readable and writable by flock-agent.`,
      ),
    );
  }

  const inventory = await inspectRemoteNodeInventory(input.host).catch(() => null);
  let availableAgents = 0;
  for (const tool of NODE_TOOL_CATALOG) {
    const detected = inventory?.tools.get(tool.binary);
    if (detected) availableAgents += 1;
    checks.push(
      check(
        `agent:${tool.binary}`,
        `${tool.binary} CLI`,
        detected ? 'pass' : 'warning',
        detected
          ? compact(`${detected.path}\t${detected.version}`, `${tool.binary} is installed.`)
          : `${tool.binary} is missing or not launchable for flock-agent.`,
      ),
    );
  }
  if (availableAgents === 0) {
    checks.push(
      check(
        'agent:any',
        'Launchable coding agent',
        'fail',
        'Install at least one supported coding-agent CLI for flock-agent.',
      ),
    );
  }

  return {
    nodeId: input.nodeId,
    generatedAt: new Date().toISOString(),
    ready: checks.every((item) => item.status !== 'fail'),
    daemonCompatibility,
    checks,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
