import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@flock/shared';

let EVENTS: Array<{ id: string; agentEventRaw: unknown }> = [];
vi.mock('../../data/queries', () => ({ useSessionEvents: () => ({ data: EVENTS }) }));
vi.mock('../paddock/liveData', () => ({ useLiveStatuses: () => new Map() }));

import { ChatPanel } from './ChatPanel';

const session = { id: 's1', status: 'idle' } as unknown as Session;

describe('ChatPanel (redesign #99 — structured conversation)', () => {
  it('renders chat events as messages and ignores non-chat events', () => {
    EVENTS = [
      { id: 'e1', agentEventRaw: { chat: { role: 'user', text: 'build JWT auth' } } },
      { id: 'e2', agentEventRaw: { chat: { role: 'assistant', text: 'On it.' } } },
      { id: 'e3', agentEventRaw: { chat: { role: 'tool', text: 'edit auth.ts' } } },
      { id: 'e4', agentEventRaw: { mappedStatus: 'running' } }, // not a chat → ignored
      { id: 'e5', agentEventRaw: null },
    ];
    render(<ChatPanel session={session} />);
    expect(screen.getByText('build JWT auth')).toBeTruthy();
    expect(screen.getByText('On it.')).toBeTruthy();
    expect(screen.getByText('edit auth.ts')).toBeTruthy();
  });

  it('shows an empty state when there are no chat events', () => {
    EVENTS = [{ id: 'e1', agentEventRaw: { mappedStatus: 'idle' } }];
    render(<ChatPanel session={session} />);
    expect(screen.getByText(/Start the conversation/i)).toBeTruthy();
  });
});
