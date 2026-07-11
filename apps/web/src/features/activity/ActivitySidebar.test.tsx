import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Event, Session } from '@flock/shared';

import { ActivitySidebar } from './ActivitySidebar';

/**
 * US-34 / FR-UI5 — the right activity sidebar.
 *
 * Acceptance criteria asserted here (component level; the sidebar mounts into
 * the US-30 AppShell `activity` slot, asserted via AppShell.test.tsx):
 *   - shows a STATUS TIMELINE derived from events,
 *   - shows SESSION METADATA,
 *   - shows ARTIFACT placeholders structured for the Phase-2 supervisor (FR-UI5),
 *   - renders a calm empty state when no session is selected.
 */

const SESSION: Session = {
  id: '11111111-1111-1111-1111-111111111111',
  nodeId: '22222222-2222-2222-2222-222222222222',
  projectId: '33333333-3333-3333-3333-333333333333',
  agentType: 'claude-code',
  tmuxSessionName: 'flock-sess-1',
  workingDir: '/home/dev/project',
  browserCdpEndpoint: null,
  hookTokenHash: 'super-secret-hash',
  status: 'awaiting_input',
  statusDetail: 'Approve edit to src/app.ts?',
  pinned: false,
  note: null,
  createdAt: '2026-05-29T09:00:00.000Z',
  lastStatusAt: '2026-05-29T09:05:00.000Z',
  createdBy: '44444444-4444-4444-4444-444444444444',
  closedAt: null,
};

function evt(partial: Partial<Event> & Pick<Event, 'id' | 'ts' | 'mappedStatus'>): Event {
  return {
    sessionId: SESSION.id,
    type: 'status',
    source: 'hook',
    agentEventRaw: null,
    detail: null,
    ...partial,
  };
}

const EVENTS: Event[] = [
  evt({ id: 'e1', ts: '2026-05-29T09:00:00.000Z', mappedStatus: 'starting' }),
  evt({ id: 'e2', ts: '2026-05-29T09:02:00.000Z', mappedStatus: 'running' }),
  evt({
    id: 'e3',
    ts: '2026-05-29T09:05:00.000Z',
    mappedStatus: 'awaiting_input',
    detail: 'Approve edit?',
  }),
];

describe('ActivitySidebar (US-34)', () => {
  it('renders a status timeline from events, newest-first, with status dots', () => {
    render(<ActivitySidebar session={SESSION} events={EVENTS} />);

    const timeline = screen.getByTestId('activity-timeline');
    const entries = within(timeline).getAllByTestId('timeline-entry');
    expect(entries).toHaveLength(3);

    expect(entries[0]).toHaveAttribute('data-status', 'awaiting_input');
    expect(entries[2]).toHaveAttribute('data-status', 'starting');

    expect(within(entries[0]).getByTestId('status-indicator')).toBeInTheDocument();
  });

  it('shows the session note and saves edits via onSaveNote (on blur)', () => {
    const onSaveNote = vi.fn();
    render(
      <ActivitySidebar
        session={{ ...SESSION, note: 'old note' }}
        events={EVENTS}
        onSaveNote={onSaveNote}
      />,
    );
    const ta = screen.getByTestId('session-note-input') as HTMLTextAreaElement;
    expect(ta.value).toBe('old note');
    fireEvent.change(ta, { target: { value: 'refactoring auth' } });
    fireEvent.blur(ta);
    expect(onSaveNote).toHaveBeenCalledWith('refactoring auth');
  });

  it('clears the note to null when emptied', () => {
    const onSaveNote = vi.fn();
    render(
      <ActivitySidebar
        session={{ ...SESSION, note: 'x' }}
        events={EVENTS}
        onSaveNote={onSaveNote}
      />,
    );
    const ta = screen.getByTestId('session-note-input');
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.blur(ta);
    expect(onSaveNote).toHaveBeenCalledWith(null);
  });

  it('shows session metadata (agent, working dir)', () => {
    render(<ActivitySidebar session={SESSION} events={EVENTS} />);

    const meta = screen.getByTestId('activity-metadata');
    expect(within(meta).getByText('/home/dev/project')).toBeInTheDocument();
    expect(within(meta).getByText('claude-code')).toBeInTheDocument();
  });

  it('never renders the hook token hash (secret material)', () => {
    render(<ActivitySidebar session={SESSION} events={EVENTS} />);
    expect(screen.queryByText('super-secret-hash')).not.toBeInTheDocument();
  });

  it('shows the Plan section (empty hint when the agent has no plan yet)', () => {
    render(<ActivitySidebar session={SESSION} events={EVENTS} />);
    const plan = screen.getByTestId('activity-plan');
    expect(plan).toBeInTheDocument();
    expect(within(plan).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('fills the Plan from the agent plan, with completed items struck through', () => {
    render(
      <ActivitySidebar
        session={SESSION}
        events={EVENTS}
        plan={{
          updatedAt: '2026-05-29T09:05:00.000Z',
          items: [
            { content: 'Parse status', status: 'completed' },
            { content: 'Wire the route', status: 'in_progress' },
            { content: 'Add tests', status: 'pending' },
          ],
        }}
      />,
    );
    const plan = screen.getByTestId('activity-plan');
    expect(within(plan).getByText('Wire the route')).toBeInTheDocument();
    const done = within(plan).getByText('Parse status');
    expect(done).toHaveClass('line-through');
    expect(within(plan).getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders a calm empty state when no session is selected', () => {
    render(<ActivitySidebar session={null} events={[]} />);
    expect(screen.getByTestId('activity-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-timeline')).not.toBeInTheDocument();
  });

  it('labels the region "Activity" and is keyboard/AT discoverable', () => {
    render(<ActivitySidebar session={SESSION} events={EVENTS} />);
    expect(screen.getByRole('heading', { name: /activity/i })).toBeInTheDocument();
  });
});
