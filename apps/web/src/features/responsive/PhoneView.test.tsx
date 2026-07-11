/**
 * PhoneView — agents list + driveable stage (herdr-aligned).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { PhoneSession } from './PhoneView';
import { PhoneView } from './PhoneView';
import { usePaddock } from '../../store/paddock';

const terminalSend = vi.hoisted(() => vi.fn());
const terminalFocus = vi.hoisted(() => vi.fn());
vi.mock('../terminal/GhosttyMobileTerminal', () => ({
  default: ({
    registerInput,
    registerFocus,
  }: {
    registerInput?: (send: ((text: string) => void) | null) => void;
    registerFocus?: (focus: (() => void) | null) => void;
  }) => {
    registerInput?.(terminalSend);
    registerFocus?.(terminalFocus);
    return (
      <div data-testid="mock-ghostty-terminal" data-renderer="ghostty">
        Live terminal
      </div>
    );
  },
}));

const sessions: PhoneSession[] = [
  {
    id: 'calm',
    label: 'web · feature-x',
    status: 'running',
    projectId: 'p1',
    projectName: 'Flock',
    nodeId: 'n1',
    nodeName: 'Mac Studio',
  },
  {
    id: 'blocked',
    label: 'api · migrate-db',
    status: 'awaiting_input',
    projectId: 'p1',
    projectName: 'Flock',
    nodeId: 'n1',
    nodeName: 'Mac Studio',
  },
  {
    id: 'broke',
    label: 'infra · deploy',
    status: 'error',
    projectId: 'p2',
    projectName: 'Deploy',
    nodeId: 'n2',
    nodeName: 'VPS',
  },
  {
    id: 'quiet',
    label: 'docs · readme',
    status: 'idle',
    projectId: 'p1',
    projectName: 'Flock',
    nodeId: 'n1',
    nodeName: 'Mac Studio',
  },
];

describe('PhoneView (herdr-aligned mobile stage)', () => {
  beforeEach(() => {
    terminalSend.mockReset();
    terminalFocus.mockReset();
    usePaddock.setState({
      selectedSessionId: null,
      selectedProjectId: null,
      lens: 'agents',
      dialog: null,
      dialogProjectId: null,
    });
  });

  it('renders Agents list of sessions', () => {
    render(<PhoneView sessions={sessions} />);
    expect(screen.getByRole('heading', { name: 'Flock' })).toBeVisible();
    expect(screen.getByText(/all nodes · agents/i)).toBeVisible();
    for (const s of sessions) {
      expect(screen.getByText(s.label)).toBeVisible();
    }
    expect(screen.getByText('Mac Studio')).toBeVisible();
    expect(screen.getByText('VPS')).toBeVisible();
    expect(screen.getAllByText('Flock').length).toBeGreaterThanOrEqual(2);
  });

  it('floats attention sessions to the top of their node groups', () => {
    render(<PhoneView sessions={sessions} />);
    const groups = screen.getAllByTestId('phone-node-group');
    expect(within(groups[0]!).getAllByTestId('phone-session')[0]).toHaveAttribute(
      'data-session-id',
      'blocked',
    );
    expect(within(groups[1]!).getAllByTestId('phone-session')[0]).toHaveAttribute(
      'data-session-id',
      'broke',
    );
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
    expect(screen.queryByTestId('phone-stage-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('phone-live-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('mock-ghostty-terminal')).toHaveAttribute('data-renderer', 'ghostty');
    expect(screen.getByTestId('phone-brand')).toHaveTextContent('Flock');
  });

  it('exposes the compact agent-switcher menu', () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    render(<PhoneView sessions={sessions} />);

    expect(screen.getByRole('button', { name: 'Open mobile navigation' })).toBeVisible();
  });

  it('docks terminal accessory keys below the Ghostty terminal', () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    render(<PhoneView sessions={sessions} />);

    const keys = screen.getByTestId('phone-key-strip');
    const terminal = screen.getByTestId('phone-live-terminal');
    expect(keys).toHaveTextContent('EscTab⇧Tab↑↓EnterCtrl-C');
    expect(terminal.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('starts a new agent in a project from the mobile hierarchy', () => {
    render(<PhoneView sessions={sessions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start agent in Flock' }));

    expect(usePaddock.getState()).toMatchObject({ dialog: 'session', dialogProjectId: 'p1' });
  });

  it('sends accessory keys through the live terminal', () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    render(<PhoneView sessions={sessions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(terminalSend).toHaveBeenCalledWith('\r');
    expect(screen.getByTestId('mock-ghostty-terminal')).toBeInTheDocument();
  });

  it('sends the standard back-tab sequence for mobile mode switching', () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    render(<PhoneView sessions={sessions} />);

    fireEvent.click(screen.getByRole('button', { name: '⇧Tab' }));
    expect(terminalSend).toHaveBeenCalledWith('\u001b[Z');
  });

  it('accessory keys use the optional test input override', () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    const onSend = vi.fn();
    render(<PhoneView sessions={sessions} onSendInput={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(onSend).toHaveBeenCalledWith('blocked', '\u001b', false);
  });

  it('provides an explicit mobile keyboard fallback', () => {
    usePaddock.setState({ selectedSessionId: 'blocked' });
    render(<PhoneView sessions={sessions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal keyboard' }));
    expect(terminalFocus).toHaveBeenCalledOnce();
  });

  it('shows empty list message when no sessions', () => {
    render(<PhoneView sessions={[]} />);
    expect(screen.getByText(/no nodes yet/i)).toBeVisible();
  });
});
