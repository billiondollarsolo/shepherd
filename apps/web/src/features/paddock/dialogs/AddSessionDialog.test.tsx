import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo } from '@flock/shared';

import { Dialog } from '../../../components/ui';
import { usePaddock } from '../../../store/paddock';

let nodeInfo: NodeInfo;

vi.mock('../../../data/queries', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        nodeId: 'node-1',
        name: 'api',
        workingDir: '/work/api',
        agentPolicy: {
          defaultAuthority: 'callback_only',
          maxAuthority: 'callback_only',
        },
      },
    ],
  }),
  useNodeInfo: () => ({ data: nodeInfo, isSuccess: true }),
  useCreateSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock('../../shell/launcherPresetsApi', () => ({
  fetchLauncherPresets: () => new Promise<never>(() => undefined),
}));

import { AddSessionDialog } from './AddSessionDialog';

function renderDialog(): void {
  render(
    <Dialog open>
      <AddSessionDialog />
    </Dialog>,
  );
}

function daemonInfo(state: 'recommended' | 'required'): NodeInfo {
  return {
    hostname: 'worker-1',
    os: 'linux',
    kernel: '6.8',
    uptimeSec: 60,
    cores: 8,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    cpuPercent: 5,
    memTotal: 16_000,
    memUsed: 4_000,
    diskTotal: 100_000,
    diskUsed: 20_000,
    agents: [{ name: 'claude', path: '/usr/local/bin/claude', version: '1.0.0' }],
    lifecycle: {
      expectedDaemonVersion: '0.4.1',
      daemonCompatibility: {
        state,
        reason: state === 'required' ? 'below-minimum' : 'older-supported',
        installedVersion: state === 'required' ? '0.2.9' : '0.3.0',
        preferredVersion: '0.4.1',
        minimumVersion: '0.3.0',
        protocolVersion: 2,
        supportedProtocolVersions: [2],
        missingCapabilities: [],
        servicePrepared: true,
        binaryReplacement: true,
        detail:
          state === 'required'
            ? 'Daemon 0.2.9 is below the supported minimum 0.3.0.'
            : 'Daemon 0.3.0 is supported; 0.4.1 is recommended.',
      },
      upgrade: {
        status: 'deferred',
        installedVersion: state === 'required' ? '0.2.9' : '0.3.0',
        expectedVersion: '0.4.1',
        activeSessions: 2,
        message: 'Node daemon rollout deferred until active sessions finish.',
        requirement: state,
      },
    },
  };
}

describe('AddSessionDialog daemon compatibility', () => {
  beforeEach(() => {
    usePaddock.setState({ dialogProjectId: 'project-1', selectedProjectId: 'project-1' });
  });

  it('blocks a new session with the exact mandatory-upgrade reason', () => {
    nodeInfo = daemonInfo('required');
    renderDialog();

    expect(screen.getByRole('alert')).toHaveTextContent('New sessions are paused on this node');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Daemon 0.2.9 is below the supported minimum 0.3.0.',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('2 existing sessions remain protected');
    expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled();
  });

  it('continues to allow launches on a supported older daemon', () => {
    nodeInfo = daemonInfo('recommended');
    renderDialog();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  });
});
