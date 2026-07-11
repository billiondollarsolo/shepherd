import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Node, Project, Session } from '@flock/shared';
import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

const mutate = vi.fn();
const penAction = vi.fn();
const sessions: Session[] = [
  makeSession('idle', 'idle'),
  makeSession('working', 'running'),
  makeSession('waiting', 'awaiting_input'),
  makeSession('other-project', 'running', 'project-2', 'node-2'),
];
const nodes: Node[] = [
  {
    id: 'node-1',
    name: 'Local',
    kind: 'local',
    host: null,
    port: null,
    username: null,
    sshAuthMethod: 'key',
    sshHostKey: null,
    pool: null,
    connectionStatus: 'connected',
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'node-2',
    name: 'Remote',
    kind: 'remote',
    host: 'remote.example',
    port: 22,
    username: 'flock',
    sshAuthMethod: 'key',
    sshHostKey: null,
    pool: null,
    connectionStatus: 'connected',
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];
const projects: Project[] = [
  {
    id: 'project-1',
    nodeId: 'node-1',
    name: 'Flock',
    workingDir: '/workspace/flock',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'project-2',
    nodeId: 'node-2',
    name: 'Other',
    workingDir: '/workspace/other',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

vi.mock('../../data/queries', () => ({
  useSessions: () => ({ data: sessions }),
  useNodes: () => ({ data: nodes }),
  useProjects: () => ({ data: projects }),
  useUpdateSession: () => ({ mutate }),
}));

vi.mock('../paddock/liveData', () => ({
  useLiveStatuses: () => new Map(),
  useLiveStatusTransitions: () => new Map(),
}));

import { AgentsSwitcher } from './AgentsSwitcher';

function makeSession(
  id: string,
  status: Session['status'],
  projectId = 'project-1',
  nodeId = 'node-1',
): Session {
  return {
    id,
    nodeId,
    projectId,
    agentType: 'codex',
    tmuxSessionName: `flock-${id}`,
    workingDir: '/workspace/flock',
    browserCdpEndpoint: null,
    hookTokenHash: 'hash',
    status,
    statusDetail: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastStatusAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'user-1',
    closedAt: null,
  };
}

function renderSwitcher(): void {
  render(
    <TooltipProvider>
      <AgentsSwitcher />
    </TooltipProvider>,
  );
}

describe('AgentsSwitcher controls', () => {
  beforeEach(() => {
    mutate.mockReset();
    penAction.mockReset();
    usePaddock.setState({
      selectedSessionId: null,
      selectedProjectId: null,
      nodeInfoNodeId: null,
      projectView: 'agents',
    });
  });

  it('keeps Pen layout choices inside the kebab menu', async () => {
    usePaddock.setState({
      selectedProjectId: 'project-1',
      penProjectId: 'project-1',
      activePenId: 'pen-1',
      penGroups: [
        {
          id: 'pen-1',
          name: 'Pen 1',
          sessionIds: ['working', 'waiting'],
          arrange: 'row',
        },
      ],
      penActionHandler: penAction,
    });
    renderSwitcher();

    expect(screen.queryByRole('button', { name: 'Side by side' })).toBeNull();
    const actions = screen.getByRole('button', { name: /Pen 1 .* actions/ });
    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stacked' }));
    expect(penAction).toHaveBeenCalledWith({
      type: 'arrange',
      penId: 'pen-1',
      mode: 'col',
    });
  });

  it('uses Pens and drag order without competing view controls', () => {
    renderSwitcher();

    expect(screen.queryByRole('button', { name: 'Agent list view options' })).toBeNull();
    expect(screen.queryByText('Sort by')).toBeNull();
    expect(screen.queryByText('Group by')).toBeNull();
    expect(screen.queryByText('Pinned sessions')).toBeNull();
    expect(screen.queryByText('Currently working')).toBeNull();
    expect(screen.getByTestId('agent-row-working')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-idle')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-waiting')).toBeInTheDocument();
  });

  it('provides keyboard-equivalent Pen reordering', () => {
    usePaddock.setState({
      selectedProjectId: 'project-1',
      penProjectId: 'project-1',
      activePenId: 'pen-1',
      penGroups: [
        {
          id: 'pen-1',
          name: 'Pen 1',
          sessionIds: ['working', 'waiting'],
          arrange: 'row',
        },
      ],
      penActionHandler: penAction,
    });
    renderSwitcher();

    fireEvent.keyDown(screen.getByTestId('agent-row-waiting'), {
      key: 'ArrowUp',
      altKey: true,
    });
    expect(penAction).toHaveBeenCalledWith({
      type: 'move',
      sessionId: 'waiting',
      targetSessionId: 'working',
      penId: 'pen-1',
    });
  });

  it('keeps confirmed deletion in the agent actions menu without pinning', async () => {
    renderSwitcher();

    const workingRow = screen.getByTestId('agent-row-working').closest('li')!;
    const actions = within(workingRow).getByRole('button', {
      name: /Agent actions for codex · workin/i,
    });
    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    expect(screen.queryByRole('menuitem', { name: 'Keep at top' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session…' }));
    expect(usePaddock.getState()).toMatchObject({
      dialog: 'terminate-session',
      dialogSessionId: 'working',
    });
  });

  it('uses project context', () => {
    usePaddock.setState({
      selectedProjectId: 'project-1',
    });

    renderSwitcher();

    expect(screen.getByTestId('agent-row-working')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-waiting')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row-other-project')).toBeNull();
    expect(screen.getByTestId('agent-list-context')).toHaveTextContent('Project:Flock');
  });

  it('opens project Source Control from the sidebar', () => {
    usePaddock.setState({ selectedProjectId: 'project-1' });
    renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: 'Source Control' }));
    expect(usePaddock.getState()).toMatchObject({
      selectedProjectId: 'project-1',
      selectedSessionId: null,
      projectView: 'git',
      rightOpen: false,
    });
  });

  it('shows only agents on the selected node', () => {
    usePaddock.setState({ nodeInfoNodeId: 'node-2' });

    renderSwitcher();

    expect(screen.getByTestId('agent-row-other-project')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row-working')).toBeNull();
    expect(screen.getByTestId('agent-list-context')).toHaveTextContent('Node:Remote');
  });
});
