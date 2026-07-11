import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { usePaddock } from '../../store/paddock';

const openAgent = vi.fn();
const selectProject = vi.fn();
const openRight = vi.fn();

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
  useLiveStatuses: () => new Map([['s1', 'awaiting_input']]),
}));

import { FleetView } from './FleetView';

describe('FleetView hierarchy', () => {
  beforeEach(() => {
    openAgent.mockReset();
    selectProject.mockReset();
    openRight.mockReset();
    usePaddock.setState({ hostScope: 'all', openAgent, selectProject, openRight });
  });

  it('shows node, project, agent status, and project Git together', () => {
    render(<FleetView />);

    expect(screen.getByText('Workstation')).toBeInTheDocument();
    expect(screen.getByText('Flock')).toBeInTheDocument();
    expect(screen.getByText('UI cleanup')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('1 changed')).toBeInTheDocument();
  });

  it('opens project Git and agents in the Agents workspace', () => {
    render(<FleetView />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Flock source control' }));
    expect(openAgent).toHaveBeenCalledWith('s1', 'p1');
    expect(openRight).toHaveBeenCalledWith('diff');

    fireEvent.click(screen.getByText('UI cleanup'));
    expect(openAgent).toHaveBeenLastCalledWith('s1', 'p1');
  });
});
