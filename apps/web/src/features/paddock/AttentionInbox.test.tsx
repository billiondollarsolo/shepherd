import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session, Status } from '@flock/shared';

const SESSIONS = [
  { id: 's-run', agentType: 'claude-code', status: 'running', closedAt: null, nodeId: 'n1', projectId: 'p1', permissionMode: 'default' },
  { id: 's-wait', agentType: 'codex', status: 'idle', closedAt: null, nodeId: 'n1', projectId: 'p1', permissionMode: 'default' },
  { id: 's-plan', agentType: 'claude-code', status: 'idle', closedAt: null, nodeId: 'n1', projectId: 'p1', permissionMode: 'plan' },
  { id: 's-err', agentType: 'gemini', status: 'idle', closedAt: null, nodeId: 'n2', projectId: 'p2', permissionMode: 'default' },
  { id: 's-closed', agentType: 'amp', status: 'awaiting_input', closedAt: '2026-01-01', nodeId: 'n1', projectId: 'p1', permissionMode: 'default' },
] as unknown as Session[];
// Live overrides: s-wait blocked, s-plan awaiting in plan mode, s-err errored. s-closed CLOSED → excluded.
const mockStatuses = new Map<string, Status>([
  ['s-wait', 'awaiting_input'],
  ['s-plan', 'awaiting_input'],
  ['s-err', 'error'],
]);
const focusSession = vi.fn();

vi.mock('../../data/queries', () => ({
  useSessions: () => ({ data: SESSIONS }),
  useNodes: () => ({ data: [{ id: 'n1', name: 'vm-1' }, { id: 'n2', name: 'vm-2' }] }),
  useProjects: () => ({ data: [{ id: 'p1', name: 'Apollo' }, { id: 'p2', name: 'Gemini' }] }),
}));
vi.mock('./liveData', () => ({ useLiveStatuses: () => mockStatuses }));
vi.mock('../../store/paddock', () => ({
  usePaddock: (sel: (s: Record<string, unknown>) => unknown) => sel({ focusSession }),
}));

import { AttentionInbox, attentionItems } from './AttentionInbox';
import { TooltipProvider } from '../../components/ui';

describe('attentionItems (pure)', () => {
  it('flags plan/blocked/errored open agents — plan first, error last; excludes running/closed', () => {
    const items = attentionItems(SESSIONS, mockStatuses);
    expect(items.map((i) => [i.session.id, i.reason])).toEqual([
      ['s-plan', 'plan'],
      ['s-wait', 'blocked'],
      ['s-err', 'error'],
    ]);
  });

  it('is empty when nothing needs a human', () => {
    expect(attentionItems(SESSIONS, new Map())).toEqual([]);
  });
});

describe('AttentionInbox', () => {
  it('badges the count of agents needing attention', () => {
    render(
      <TooltipProvider>
        <AttentionInbox />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('attention-badge').textContent).toBe('3');
  });
});
