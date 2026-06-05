/**
 * US-36 — the phone-friendly away view (FR-UI6, spec line 340):
 *   "Layout collapses to a phone-friendly 'which agent needs me + approve/deny'
 *    view."
 *
 * On a phone the three-region desktop paddock is too dense, so we collapse to a
 * single scrollable column: the sessions that NEED a human (awaiting_input /
 * error) float to the top using the SAME shared attention ordering as the tree
 * (so the two surfaces can never disagree), and any session blocked on input
 * gets inline Approve / Deny buttons — the whole point of an away view.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { PhoneSession } from './PhoneView';
import { PhoneView } from './PhoneView';

const sessions: PhoneSession[] = [
  { id: 'calm', label: 'web · feature-x', status: 'running' },
  { id: 'blocked', label: 'api · migrate-db', status: 'awaiting_input' },
  { id: 'broke', label: 'infra · deploy', status: 'error' },
  { id: 'quiet', label: 'docs · readme', status: 'idle' },
];

describe('PhoneView (US-36, FR-UI6)', () => {
  it('renders a "which agent needs me" list of the sessions', () => {
    render(<PhoneView sessions={sessions} />);
    expect(screen.getByRole('heading', { name: /flock/i })).toBeVisible();
    for (const s of sessions) {
      expect(screen.getByText(s.label)).toBeVisible();
    }
  });

  it('floats the attention sessions to the top (shared ordering)', () => {
    render(<PhoneView sessions={sessions} />);
    const rows = screen.getAllByTestId('phone-session');
    const order = rows.map((r) => r.getAttribute('data-session-id'));
    // awaiting_input (rank 0) then error (rank 1) lead; calm/quiet trail.
    expect(order.slice(0, 2)).toEqual(['blocked', 'broke']);
  });

  it('is read-only (no fake remote approve/deny) and taps select a session', () => {
    const onSelectSession = vi.fn();
    render(<PhoneView sessions={sessions} onSelectSession={onSelectSession} />);

    // Remote approve/deny is intentionally NOT offered from the away view: it has
    // no real respond endpoint (a per-agent PTY-respond is a future feature), so we
    // don't ship buttons that POST to a 404. It's a glance + tap-to-open surface.
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();

    const blockedRow = screen
      .getAllByTestId('phone-session')
      .find((r) => r.getAttribute('data-session-id') === 'blocked')!;
    fireEvent.click(within(blockedRow).getByRole('button'));
    expect(onSelectSession).toHaveBeenCalledWith('blocked');
  });

  it('shows a calm empty state when nothing needs the human', () => {
    render(
      <PhoneView
        sessions={[{ id: 'calm', label: 'web · feature-x', status: 'running' }]}
      />,
    );
    expect(screen.getByTestId('phone-allclear')).toBeVisible();
  });

  it('renders an empty state when there are no sessions at all', () => {
    render(<PhoneView sessions={[]} />);
    expect(screen.getByTestId('phone-empty')).toBeVisible();
  });
});
