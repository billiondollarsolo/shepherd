import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { usePaddock } from '../../store/paddock';

const openNodeInfo = vi.fn();
const querySpies = vi.hoisted(() => ({ useNodeInfos: vi.fn() }));
const liveState = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock('../../data/queries', () => ({
  useNodes: () => ({
    data: [
      { id: 'n1', name: 'Workstation', connectionStatus: 'connected' },
      { id: 'n2', name: 'Remote', connectionStatus: 'disconnected' },
    ],
  }),
  useProjects: () => ({
    data: [{ id: 'p1', nodeId: 'n1', name: 'Flock', workingDir: '/work/flock' }],
  }),
  useSessions: () => ({
    data: [
      {
        id: 's1',
        nodeId: 'n1',
        projectId: 'p1',
        agentType: 'codex',
        note: 'UI cleanup',
        status: 'running',
        closedAt: null,
      },
    ],
  }),
  useNodeInfos: (nodeIds: string[]) => {
    querySpies.useNodeInfos(nodeIds);
    return new Map([
      [
        'n1',
        {
          cpuPercent: 25,
          memUsed: 4 * 1024 ** 3,
          memTotal: 8 * 1024 ** 3,
          diskUsed: 50 * 1024 ** 3,
          diskTotal: 100 * 1024 ** 3,
        },
      ],
    ]);
  },
  useFleetGit: () =>
    new Map([
      [
        's1',
        {
          sessionId: 's1',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 2,
          behind: 0,
          hasHead: true,
          files: [{ path: 'src/App.tsx' }],
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    ]),
}));

vi.mock('../paddock/liveData', () => ({
  useLiveStatuses: () => liveState.map,
}));

import { FleetView } from './FleetView';

describe('FleetView hierarchy', () => {
  beforeEach(() => {
    openNodeInfo.mockReset();
    querySpies.useNodeInfos.mockReset();
    liveState.map = new Map([['s1', 'awaiting_input']]);
    usePaddock.setState({ nodeOrder: [], openNodeInfo });
  });

  it('shows node cards with project and agent rollups', () => {
    render(<FleetView />);

    expect(screen.getByText('Workstation')).toBeInTheDocument();
    expect(screen.getByText('1 Needs you')).toBeInTheDocument();
    expect(screen.getAllByText('Projects')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Agents')[0]).toBeInTheDocument();
    expect(screen.getByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(querySpies.useNodeInfos).toHaveBeenCalledWith(['n1']);
  });

  it('uses the same saved node order as the sidebar when nothing needs attention', () => {
    // No ringing session → the attention partition is empty and the saved order wins.
    liveState.map = new Map([['s1', 'running']]);
    usePaddock.setState({ nodeOrder: ['n2', 'n1'] });
    render(<FleetView />);

    const cards = screen.getAllByTestId(/node-card-/);
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual([
      'node-card-n2',
      'node-card-n1',
    ]);
  });

  it('floats a node that needs you above the saved order, ringing + pulsing it', () => {
    // n1 holds an awaiting_input session; n2 is quiet. Even though the saved order
    // puts n2 first, the attention node must bubble to the top.
    liveState.map = new Map([['s1', 'awaiting_input']]);
    usePaddock.setState({ nodeOrder: ['n2', 'n1'] });
    render(<FleetView />);

    const cards = screen.getAllByTestId(/node-card-/);
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual([
      'node-card-n1',
      'node-card-n2',
    ]);

    // Signature ring + pulse on the attention card (static ring survives reduced motion).
    const attentionCard = screen.getByTestId('node-card-n1');
    expect(attentionCard.className).toContain('ring-status-awaiting');
    expect(attentionCard.className).toContain('animate-flock-pulse');
    // Rollup badge counts how many need you.
    expect(screen.getByTestId('node-attention-n1')).toHaveTextContent('1 needs you');
    // The quiet node neither rings nor shows a rollup.
    expect(screen.getByTestId('node-card-n2').className).not.toContain('animate-flock-pulse');
    expect(screen.queryByTestId('node-attention-n2')).toBeNull();
  });

  it('drills into a node card', () => {
    render(<FleetView />);

    fireEvent.click(screen.getByTestId('node-card-n1'));
    expect(openNodeInfo).toHaveBeenCalledWith('n1');
  });
});
