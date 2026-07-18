import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const statuses = new Map<string, string>();
vi.mock('./liveData', () => ({ useLiveStatuses: () => statuses }));

import { usePaddock } from '../../store/paddock';
import { RespondBar } from './RespondBar';
import type { Session } from '@flock/shared';

const session = { id: 's1', agentType: 'grok', status: 'idle' } as unknown as Session;
const sent: string[] = [];

beforeEach(() => {
  sent.length = 0;
  statuses.clear();
  usePaddock.setState({ terminalInput: (t: string) => sent.push(t) });
});

describe('RespondBar (P1 — respond from the cockpit)', () => {
  it('renders nothing unless the session is awaiting_input', () => {
    statuses.set('s1', 'running');
    const { container } = render(<RespondBar session={session} />);
    expect(container.querySelector('[data-testid="respond-bar"]')).toBeNull();
  });

  it('appears on awaiting_input and sends a typed reply (+CR) to the agent', () => {
    statuses.set('s1', 'awaiting_input');
    render(<RespondBar session={session} />);
    expect(screen.getByTestId('respond-bar')).toBeTruthy();
    fireEvent.change(screen.getByTestId('respond-input'), { target: { value: 'use option 2' } });
    fireEvent.click(screen.getByTestId('respond-send'));
    expect(sent).toEqual(['use option 2\r']);
  });

  it('an empty reply sends just Enter (accept default)', () => {
    statuses.set('s1', 'awaiting_input');
    render(<RespondBar session={session} />);
    fireEvent.click(screen.getByTestId('respond-send'));
    expect(sent).toEqual(['\r']);
  });
});
