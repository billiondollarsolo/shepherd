import type { NodePreflightCheck, NodePreflightResponse } from '@flock/shared';

import type { AgentdHost } from './agentd/ssh-agentd-host.js';

const ADMIN_HELPER = '/usr/local/sbin/flock-node-admin';
const SYSTEM_BIN = '/usr/local/lib/flock-agentd/flock-agentd';
const SUPPORTED_AGENTS = ['claude', 'codex', 'opencode', 'gemini', 'grok'] as const;

export interface RemoteNodePreflightInput {
  nodeId: string;
  host: AgentdHost;
  expectedAgentdVersion: string;
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
 * Proves that the SSH target is prepared for Flock without mutating it. Commands
 * are deliberately narrow and the root-side helper validates workspace/tool args.
 */
export async function preflightRemoteNode(
  input: RemoteNodePreflightInput,
): Promise<NodePreflightResponse> {
  const checks: NodePreflightCheck[] = [];
  const [platform, prepared, installed, disk, forwarding] = await Promise.all([
    input.host.exec('uname -s; uname -m'),
    input.host.exec(`sudo -n ${ADMIN_HELPER} preflight`),
    input.host.exec(`${SYSTEM_BIN} version 2>/dev/null`),
    input.host.exec("df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}'"),
    input.host
      .forwardOut('127.0.0.1', 22)
      .then((channel) => {
        channel.destroy();
        return true;
      })
      .catch(() => false),
  ]);
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
      'Flock node preparation',
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
  checks.push(
    check(
      'daemon-version',
      'Node daemon',
      !installedVersion
        ? 'warning'
        : installedVersion === input.expectedAgentdVersion
          ? 'pass'
          : 'warning',
      !installedVersion
        ? `Not installed yet; Flock will install ${input.expectedAgentdVersion}.`
        : installedVersion === input.expectedAgentdVersion
          ? `flock-agentd ${installedVersion}`
          : `Upgrade pending: ${installedVersion} → ${input.expectedAgentdVersion}.`,
    ),
  );

  const workspaceResults = await Promise.all(
    [...new Set(input.workspaces)].sort().map(async (workspace) => ({
      workspace,
      result: await input.host.exec(
        `sudo -n ${ADMIN_HELPER} check-workspace ${shellQuote(workspace)}`,
      ),
    })),
  );
  for (const { workspace, result } of workspaceResults) {
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

  const agentResults = await Promise.all(
    SUPPORTED_AGENTS.map(async (agent) => ({
      agent,
      result: await input.host.exec(`sudo -n ${ADMIN_HELPER} agent-version ${agent}`),
    })),
  );
  let availableAgents = 0;
  for (const { agent, result } of agentResults) {
    if (result.code === 0) availableAgents += 1;
    checks.push(
      check(
        `agent:${agent}`,
        `${agent} CLI`,
        result.code === 0 ? 'pass' : 'warning',
        result.code === 0
          ? compact(result.stdout, `${agent} is installed.`)
          : compact(
              result.stderr || result.stdout,
              `${agent} is missing or not launchable for flock-agent.`,
            ),
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
    checks,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
