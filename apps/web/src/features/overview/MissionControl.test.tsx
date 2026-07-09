import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const SESSIONS = [
  { id: 's-run', agentType: 'claude-code', status: 'running', closedAt: null, nodeId: 'n1', projectId: 'p1' },
  { id: 's-wait', agentType: 'codex', status: 'idle', closedAt: null, nodeId: 'n1', projectId: 'p1' },
  { id: 's-closed', agentType: 'gemini', status: 'done', closedAt: '2026-01-01', nodeId: 'n1', projectId: 'p1' },
];
const mockStatuses = new Map<string, string>([['s-wait', 'awaiting_input']]);
const openAgent = vi.fn();

vi.mock('../../data/queries', () => ({
  useSessions: () => ({ data: SESSIONS }),
  useLatestChats: () => ({ data: {} }),
  useTeams: () => ({ data: [] }),
  useNodes: () => ({ data: [{ id: 'n1', name: 'vm-1' }] }),
  useProjects: () => ({ data: [{ id: 'p1', name: 'Apollo' }] }),
  useFleetGit: () => new Map(),
  useUpdateSession: () => ({ mutate: () => {} }),
}));
vi.mock('../paddock/liveData', () => ({
  useLiveStatuses: () => mockStatuses,
  useAgentdHealth: () => ({ sessions: {} }),
}));
vi.mock('../../store/paddock', () => ({
  usePaddock: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      openAgent,
      reviewedSessions: [],
      setReviewed: () => {},
      openDialog: () => {},
      openRight: () => {},
      hostScope: 'all',
    }),
}));

import { MissionControl } from './MissionControl';
import { TooltipProvider } from '../../components/ui';

const renderMC = (): ReturnType<typeof render> =>
  render(
    <TooltipProvider>
      <MissionControl />
    </TooltipProvider>,
  );

describe('MissionControl (elite UI)', () => {
  it('surfaces the needs-you count and excludes closed sessions', () => {
    renderMC();
    expect(screen.getByTestId('mc-needs-you').textContent).toMatch(/1 needs you/i);
    expect(screen.getByTestId('mc-card-s-run')).toBeTruthy();
    expect(screen.getByTestId('mc-card-s-wait')).toBeTruthy();
    expect(screen.queryByTestId('mc-card-s-closed')).toBeNull(); // closed → not shown
  });

  it('sorts the awaiting_input agent to the top (the money state)', () => {
    renderMC();
    const cards = screen.getAllByTestId(/^mc-card-/);
    expect(cards[0].getAttribute('data-testid')).toBe('mc-card-s-wait');
  });

  it('clicking a card opens agent with session id AND projectId (D2)', () => {
    renderMC();
    fireEvent.click(screen.getByTestId('mc-card-s-run'));
    expect(openAgent).toHaveBeenCalledWith('s-run', 'p1');
  });
});
