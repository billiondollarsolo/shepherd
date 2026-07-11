import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Node, Project, Session } from '@flock/shared';
import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

const mutate = vi.fn();
const sessions: Session[] = [
  makeSession('pinned-idle', 'idle', true),
  makeSession('working', 'running'),
  makeSession('waiting', 'awaiting_input'),
  makeSession('other-project', 'running', false, 'project-2', 'node-2'),
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
  pinned = false,
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
    worktreeBranch: null,
    pinned,
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
    usePaddock.setState({
      hostScope: 'all',
      selectedSessionId: null,
      selectedProjectId: null,
      nodeInfoNodeId: null,
    });
  });

  it('condenses sort, group, and filters into one view menu', async () => {
    renderSwitcher();

    const trigger = screen.getByRole('button', { name: 'Agent list view options' });
    expect(trigger).toHaveTextContent('View');
    expect(trigger).toHaveTextContent('Needs attention');
    expect(screen.queryByText('Sort by')).toBeNull();

    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
    expect(await screen.findByText('Sort by')).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: 'Needs attention' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'No grouping' })).toBeChecked();
  });

  it('keeps filters out of the header and filters to currently working sessions', async () => {
    renderSwitcher();
    expect(screen.queryByText('Currently working')).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Agent list view options' }), {
      key: 'Enter',
      code: 'Enter',
    });
    const workingOnly = await screen.findByRole('menuitemcheckbox', {
      name: 'Currently working',
    });
    fireEvent.click(workingOnly);

    expect(screen.getByTestId('agent-row-working')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row-pinned-idle')).toBeNull();
    expect(screen.queryByTestId('agent-row-waiting')).toBeNull();
    expect(screen.getByRole('button', { name: 'Agent list view options' })).toHaveTextContent('1');
  });

  it('puts pinning and confirmed deletion in an agent actions menu', async () => {
    renderSwitcher();

    const workingRow = screen.getByTestId('agent-row-working').closest('li')!;
    const actions = within(workingRow).getByRole('button', {
      name: /Agent actions for codex · workin/i,
    });
    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Keep at top' }));
    expect(mutate).toHaveBeenCalledWith({
      id: 'working',
      patch: { pinned: true },
    });

    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session…' }));
    expect(usePaddock.getState()).toMatchObject({
      dialog: 'terminate-session',
      dialogSessionId: 'working',
    });
  });

  it('uses project context instead of a hidden fleet scope', () => {
    usePaddock.setState({
      hostScope: { nodeId: 'some-other-node' },
      selectedProjectId: 'project-1',
    });

    renderSwitcher();

    expect(screen.getByTestId('agent-row-working')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-waiting')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-pinned-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row-other-project')).toBeNull();
    expect(screen.getByTestId('agent-list-context')).toHaveTextContent('Project:Flock');
  });

  it('shows only agents on the selected node', () => {
    usePaddock.setState({ nodeInfoNodeId: 'node-2' });

    renderSwitcher();

    expect(screen.getByTestId('agent-row-other-project')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row-working')).toBeNull();
    expect(screen.getByTestId('agent-list-context')).toHaveTextContent('Node:Remote');
  });
});
