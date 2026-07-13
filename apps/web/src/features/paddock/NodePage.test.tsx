import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

let mockFailure:
  | {
      code: 'network' | 'authentication' | 'protocol' | 'enrollment';
      message: string;
      at: string;
    }
  | undefined;
let withInfo = true;
let upgradeAvailable = false;

vi.mock('../../data/queries', () => ({
  useNodes: () => ({
    data: [
      {
        id: 'node-1',
        name: 'workstation',
        kind: upgradeAvailable ? 'ssh' : 'local',
        connectionStatus: 'connected',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  }),
  useProjects: () => ({ data: [] }),
  useSessions: () => ({ data: [] }),
  useFleetGit: () => new Map(),
  useNodePreflight: () => ({
    data: {
      nodeId: '11111111-1111-4111-8111-111111111111',
      generatedAt: '2026-07-12T00:00:00.000Z',
      ready: !upgradeAvailable,
      daemonCompatibility: {
        state: upgradeAvailable ? 'recommended' : 'compatible',
        reason: upgradeAvailable ? 'service-migration' : 'current',
        installedVersion: '0.3.0',
        preferredVersion: '0.3.0',
        minimumVersion: '0.3.0',
        protocolVersion: 2,
        supportedProtocolVersions: [2],
        missingCapabilities: [],
        servicePrepared: !upgradeAvailable,
        binaryReplacement: false,
        detail: upgradeAvailable
          ? 'The managed service needs migration.'
          : 'Daemon satisfies the current compatibility policy.',
      },
      checks: [
        {
          id: 'preparation',
          label: 'Shepherd node preparation',
          status: upgradeAvailable ? 'fail' : 'pass',
          detail: upgradeAvailable ? 'Managed service migration required.' : 'Prepared.',
        },
      ],
    },
  }),
  useUpgradeNodeAgentd: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useNodeInfo: () => ({
    data: withInfo
      ? {
          hostname: 'workstation',
          os: 'linux',
          kernel: '6.8',
          cpuPercent: 5,
          cores: 8,
          memTotal: 16_000,
          memUsed: 4_000,
          diskTotal: 100_000,
          diskUsed: 20_000,
          load1: 0.1,
          load5: 0.2,
          load15: 0.3,
          uptimeSec: 60,
          agents: [],
          lifecycle: {
            expectedDaemonVersion: '0.3.0',
            daemonCompatibility: {
              state: 'compatible',
              reason: 'current',
              installedVersion: '0.3.0',
              preferredVersion: '0.3.0',
              minimumVersion: '0.3.0',
              protocolVersion: 2,
              supportedProtocolVersions: [2],
              missingCapabilities: [],
              servicePrepared: true,
              binaryReplacement: false,
              detail: 'Daemon satisfies the current compatibility policy.',
            },
            upgrade: null,
          },
          control: {
            mode: 'secure',
            protocol: 2,
            nodeId: 'node-1',
            daemonVersion: '0.3.0',
            connections: 4,
            authFailures: 1,
            malformedFrames: 2,
            writeTimeouts: 0,
            droppedOutputBytes: 32,
            sessionsOpened: 3,
            sessionsClosed: 2,
            credentialRotations: 1,
          },
        }
      : undefined,
    isLoading: false,
    isError: !withInfo,
  }),
}));

vi.mock('./liveData', () => ({
  useLiveStatuses: () => new Map(),
  useAgentdHealth: () => ({
    enabled: true,
    nodes: { 'node-1': { link: 'down', failure: mockFailure } },
    sessions: {},
  }),
}));

import { NodePage } from './NodePage';

describe('NodePage control diagnostics', () => {
  beforeEach(() => {
    withInfo = true;
    mockFailure = undefined;
    upgradeAvailable = false;
    usePaddock.setState({ nodeInfoNodeId: 'node-1' });
  });

  it('shows safe daemon identity and bounded counters', () => {
    render(
      <TooltipProvider>
        <NodePage />
      </TooltipProvider>,
    );

    expect(screen.getByText('Secure')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('0.3.0')).toBeInTheDocument();
    expect(screen.getByText('3 anomalies')).toBeInTheDocument();
    expect(screen.getByText('32 bytes')).toBeInTheDocument();
  });

  it('shows only the server-redacted failure when node info is unavailable', () => {
    withInfo = false;
    mockFailure = {
      code: 'authentication',
      message: 'The daemon rejected the node control credential.',
      at: '2026-07-11T00:00:00.000Z',
    };
    render(
      <TooltipProvider>
        <NodePage />
      </TooltipProvider>,
    );

    expect(screen.getByText('authentication')).toBeInTheDocument();
    expect(
      screen.getByText('The daemon rejected the node control credential.'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret');
  });

  it('confirms a daemon migration instead of running it from a single click', () => {
    upgradeAvailable = true;
    render(
      <TooltipProvider>
        <NodePage />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade daemon…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Upgrade node daemon?');
    expect(screen.getByRole('button', { name: 'Upgrade daemon' })).toBeInTheDocument();
  });
});
