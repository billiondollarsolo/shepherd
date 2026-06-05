import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Session } from '@flock/shared';

import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

// jsdom has neither; the kanban grid uses both. Stub them as no-ops.
beforeAll(() => {
  // @ts-expect-error - minimal stub
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('../terminal/Terminal', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid={`term-${sessionId}`} />,
}));

function mk(id: string, projectId = 'P'): Session {
  return {
    id,
    nodeId: 'n',
    projectId,
    agentType: 'claude-code',
    tmuxSessionName: `flock-${id}`,
    workingDir: '/w',
    browserCdpEndpoint: null,
    hookTokenHash: 'h',
    status: 'running',
    statusDetail: null,
    worktreeBranch: null,
    pinned: false,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastStatusAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u',
    closedAt: null,
  };
}

// Project P has a,b,c; project Q has q.
const SESSIONS = [mk('a'), mk('b'), mk('c'), mk('q', 'Q')];
let mockStatuses = new Map<string, string>();
let mockHealth: { sessions: Record<string, { live: boolean; tokens?: number; tool?: string }> } | null =
  null;
vi.mock('../../data/queries', () => ({
  useSessions: () => ({ data: SESSIONS }),
  useProjects: () => ({
    data: [{ id: 'P', name: 'proj-P', nodeId: 'n', workingDir: '/w', createdAt: '2026-01-01T00:00:00.000Z' }],
  }),
  // GridCell renders TerminalArea (drag-drop upload), which reads this hook.
  useWriteNodeFile: () => ({ mutateAsync: async () => {} }),
}));
vi.mock('./liveData', () => ({
  useLiveStatuses: () => mockStatuses,
  useAgentdHealth: () => mockHealth,
}));

import { GridView } from './GridView';

describe('GridView (kanban — per-project, scroll, tabs)', () => {
  beforeEach(() => {
    usePaddock.setState({ viewMode: 'grid', selectedSessionId: 'a', dialog: null });
    mockStatuses = new Map();
    mockHealth = null;
  });

  it("shows the CURRENT project's sessions as panes (and not other projects')", async () => {
    render(<GridView />);
    expect(await screen.findByTestId('grid-cell-a')).toBeInTheDocument();
    expect(screen.getByTestId('grid-cell-b')).toBeInTheDocument();
    expect(screen.getByTestId('grid-cell-c')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-cell-q')).toBeNull(); // project Q
    expect(screen.getByText('proj-P')).toBeInTheDocument();
  });

  it('renders a tab per session in the tab strip', () => {
    render(<GridView />);
    const tabs = screen.getByTestId('grid-tabs');
    expect(within(tabs).getByTestId('grid-tab-a')).toBeInTheDocument();
    expect(within(tabs).getByTestId('grid-tab-b')).toBeInTheDocument();
    expect(within(tabs).getByTestId('grid-tab-c')).toBeInTheDocument();
  });

  it('clicking a tab selects + scrolls (stays in grid, does not switch to focus)', () => {
    render(<GridView />);
    const tab = within(screen.getByTestId('grid-tab-b')).getByTitle(/scroll into view/i);
    fireEvent.click(tab);
    expect(usePaddock.getState().selectedSessionId).toBe('b');
    expect(usePaddock.getState().viewMode).toBe('grid'); // NOT switched away
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('double-clicking a tab maximizes (focus view)', () => {
    render(<GridView />);
    const tab = within(screen.getByTestId('grid-tab-c')).getByTitle(/scroll into view/i);
    fireEvent.doubleClick(tab);
    expect(usePaddock.getState().viewMode).toBe('focus');
    expect(usePaddock.getState().selectedSessionId).toBe('c');
  });

  it("a tab's × opens the terminate confirm for that session", () => {
    render(<GridView />);
    const tab = screen.getByTestId('grid-tab-b');
    fireEvent.click(within(tab).getByLabelText('Terminate session'));
    expect(usePaddock.getState().dialog).toBe('terminate-session');
    expect(usePaddock.getState().dialogSessionId).toBe('b');
  });

  it('the + button opens the new-session dialog scoped to the project', () => {
    render(<GridView />);
    fireEvent.click(screen.getByLabelText('New session'));
    expect(usePaddock.getState().dialog).toBe('session');
    expect(usePaddock.getState().dialogProjectId).toBe('P');
  });

  it('shows the empty state when no session is selected (no project scope)', () => {
    usePaddock.setState({ selectedSessionId: null });
    render(<GridView />);
    expect(screen.queryByTestId('grid-cells')).toBeNull();
  });

  it("a pane's × opens the terminate confirm for that session", async () => {
    render(<GridView />);
    const cell = await screen.findByTestId('grid-cell-b');
    fireEvent.click(within(cell).getByLabelText('Terminate session'));
    expect(usePaddock.getState().dialog).toBe('terminate-session');
    expect(usePaddock.getState().dialogSessionId).toBe('b');
  });

  it('maximizing from a pane switches to focus view + selects the session', async () => {
    render(<GridView />);
    const cell = await screen.findByTestId('grid-cell-b');
    fireEvent.click(within(cell).getByLabelText('Focus session'));
    expect(usePaddock.getState().viewMode).toBe('focus');
    expect(usePaddock.getState().selectedSessionId).toBe('b');
  });

  it('reflects LIVE status on a pane', async () => {
    mockStatuses = new Map([['a', 'awaiting_input']]);
    render(<GridView />);
    const cell = await screen.findByTestId('grid-cell-a');
    expect(cell).toHaveAttribute('data-status', 'awaiting_input');
  });

  it('shows the telemetry footer when agentd health has usage', async () => {
    mockHealth = { sessions: { a: { live: true, tokens: 12000, tool: 'Edit app.ts' } } };
    render(<GridView />);
    const usage = await screen.findByTestId('grid-usage-a');
    expect(usage).toHaveTextContent('Edit app.ts');
    expect(usage).toHaveTextContent('12k tok');
  });

  it('mounts a real terminal per pane', async () => {
    render(<GridView />);
    expect(await screen.findByTestId('term-a')).toBeInTheDocument();
    expect(await screen.findByTestId('term-b')).toBeInTheDocument();
  });
});
