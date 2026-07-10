/**
 * PhoneView — agents list + driveable stage (herdr-aligned).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { PhoneSession } from './PhoneView';
import { PhoneView } from './PhoneView';
import { usePaddock } from '../../store/paddock';

const sessions: PhoneSession[] = [
  { id: 'calm', label: 'web · feature-x', status: 'running', projectId: 'p1' },
  { id: 'blocked', label: 'api · migrate-db', status: 'awaiting_input', projectId: 'p1' },
  { id: 'broke', label: 'infra · deploy', status: 'error', projectId: 'p1' },
  { id: 'quiet', label: 'docs · readme', status: 'idle', projectId: 'p1' },
];

describe('PhoneView (herdr-aligned mobile stage)', () => {
  beforeEach(() => {
    usePaddock.setState({ selectedSessionId: null, selectedProjectId: null, lens: 'agents' });
  });

  it('renders Agents list of sessions', () => {
    render(<PhoneView sessions={sessions} />);
    expect(screen.getByRole('heading', { name: /agents/i })).toBeVisible();
    for (const s of sessions) {
      expect(screen.getByText(s.label)).toBeVisible();
    }
  });

  it('floats the attention sessions to the top (shared ordering)', () => {
    render(<PhoneView sessions={sessions} />);
    const rows = screen.getAllByTestId('phone-session');
    const order = rows.map((r) => r.getAttribute('data-session-id'));
    expect(order.slice(0, 2)).toEqual(['blocked', 'broke']);
  });

  it('tap opens agent stage via openAgent + optional callback', () => {
    const onSelectSession = vi.fn();
    render(<PhoneView sessions={sessions} onSelectSession={onSelectSession} />);

    const blockedRow = screen
      .getAllByTestId('phone-session')
      .find((r) => r.getAttribute('data-session-id') === 'blocked')!;
    fireEvent.click(within(blockedRow).getByRole('button'));
    expect(onSelectSession).toHaveBeenCalledWith('blocked');
    expect(usePaddock.getState().selectedSessionId).toBe('blocked');
    expect(usePaddock.getState().lens).toBe('agents');
    expect(screen.getByTestId('phone-stage')).toBeInTheDocument();
    expect(screen.getByTestId('phone-key-strip')).toBeInTheDocument();
    expect(screen.getByTestId('phone-stage-input')).toBeInTheDocument();
  });

  it('stage/send fires onSendInput', async () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    const onSend = vi.fn();
    render(<PhoneView sessions={sessions} onSendInput={onSend} />);
    fireEvent.change(screen.getByTestId('phone-stage-input'), { target: { value: 'y' } });
    fireEvent.click(screen.getByTestId('phone-send-btn'));
    expect(onSend).toHaveBeenCalledWith('blocked', 'y', true);
    await waitFor(() => expect(screen.getByTestId('phone-send-btn')).not.toBeDisabled());
  });

  it('shows empty list message when no sessions', () => {
    render(<PhoneView sessions={[]} />);
    expect(screen.getByText(/no agents in the paddock/i)).toBeVisible();
  });
});
