import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import { createContext, type ReactElement } from 'react';
import type { Node as FlockNode, Project, Session, Status } from '@flock/shared';

import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';
import { NodeRow } from './SidebarTree';

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

// ── Mock data ────────────────────────────────────────────────────────────────
// Node NODE holds two projects: P1 (a session AWAITING input) and P2 (a session
// merely RUNNING). Ordering must float P1 above P2 even though P2 is listed first.
const NODE = {
  id: 'NODE',
  name: 'workhorse',
  kind: 'local',
  connectionStatus: 'connected',
  pool: null,
} as unknown as FlockNode;

function proj(id: string, name: string): Project {
  return { id, name, nodeId: 'NODE', workingDir: '/w' } as unknown as Project;
}
function sess(id: string, projectId: string, status: Status): Session {
  return {
    id,
    projectId,
    nodeId: 'NODE',
    agentType: 'claude-code',
    permissionMode: 'default',
    status,
    closedAt: null,
  } as unknown as Session;
}

// P2 listed BEFORE P1 so attention-sorting is observable in the DOM.
const PROJECTS = [proj('P2', 'beta'), proj('P1', 'alpha')];
let SESSIONS: Session[] = [];

vi.mock('../../data/queries', () => ({
  useProjects: () => ({ data: PROJECTS }),
  useSessions: () => ({ data: SESSIONS }),
  useStack: () => ({ data: { stacks: [] } }),
}));

// Real contexts so SessionRow's useContext calls resolve; useLiveStatuses returns
// an empty map so rows fall back to each session's (mocked) create-time status.
vi.mock('./liveData', () => ({
  LiveStatusContext: createContext(new Map()),
  AgentdHealthContext: createContext(null),
  useLiveStatuses: () => new Map(),
}));

const noop = (): void => {};

describe('NodeRow branch-level attention (task 3.2)', () => {
  beforeEach(() => {
    SESSIONS = [sess('s-await', 'P1', 'awaiting_input'), sess('s-run', 'P2', 'running')];
    // Reset persisted expand/collapse so a prior test's collapse doesn't leak.
    usePaddock.setState({ selectedProjectId: null, selectedSessionId: null, treeExpanded: {} });
  });

  it('floats the attention project above the calm one (sortGroupsByAttention)', () => {
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    const awaiting = screen.getByTestId('session-s-await');
    const running = screen.getByTestId('session-s-run');
    // P1 (awaiting) precedes P2 (running) despite P2 being first in the data.
    expect(awaiting.compareDocumentPosition(running) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the per-node "N need you" rollup count', () => {
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    const rollup = screen.getByTestId('node-attention-NODE');
    expect(rollup).toHaveTextContent('1');
  });

  it('renders a pulsing awaiting-hued dot on the COLLAPSED header, and none expanded', () => {
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    const rollup = screen.getByTestId('node-attention-NODE');
    // Expanded: rollup shows the count but no standalone pulsing dot (children visible).
    expect(rollup.querySelector('.flock-status-dot')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Collapse workhorse/ }));
    const collapsed = screen.getByTestId('node-attention-NODE');
    const dot = collapsed.querySelector('.flock-status-dot');
    expect(dot).not.toBeNull();
    // Same signature affordance as a session dot: awaiting hue + the flock pulse.
    expect(dot).toHaveAttribute('data-status', 'awaiting_input');
    expect(dot?.className).toContain('animate-flock-pulse');
  });

  it('drops the rollup entirely when nothing needs attention', () => {
    SESSIONS = [sess('s-run', 'P2', 'running')];
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    expect(screen.queryByTestId('node-attention-NODE')).toBeNull();
  });
});

describe('NodeRow keyboard/touch-reachable actions (task 3.3, WCAG 2.4.7)', () => {
  beforeEach(() => {
    SESSIONS = [sess('s-await', 'P1', 'awaiting_input'), sess('s-run', 'P2', 'running')];
    usePaddock.setState({ selectedProjectId: null, selectedSessionId: null, treeExpanded: {} });
  });

  it('reveals the node action buttons on keyboard focus (not only hover)', () => {
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    const info = screen.getByLabelText('Node info');
    // A low resting opacity (touch) that lifts on hover AND on focus.
    expect(info.className).toContain('opacity-40');
    expect(info.className).toContain('group-focus-within/nrow:opacity-100');
    expect(info.className).toContain('focus-visible:opacity-100');
  });

  it('reveals the destructive Terminate control on keyboard focus', () => {
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    const term = screen.getAllByLabelText('Terminate session')[0]!;
    expect(term.className).toContain('group-focus-within/srow:opacity-100');
    expect(term.className).toContain('focus-visible:opacity-100');
  });
});

describe('ProjectRow scoped highlight (task 3.3)', () => {
  beforeEach(() => {
    SESSIONS = [sess('s-run', 'P2', 'running')];
    usePaddock.setState({ treeExpanded: {} });
  });

  it('mirrors the selected treatment on the currently-scoped project', () => {
    usePaddock.setState({ selectedProjectId: 'P2', selectedSessionId: null });
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    // The scoped project row carries the solid raised-surface selection pill.
    const label = screen.getByText('beta');
    const row = label.closest('.group\\/prow') as HTMLElement;
    expect(row.className).toContain('bg-flock-surface-3');
    expect(within(row).getByRole('button', { name: 'New session' })).toBeTruthy();
  });

  it('does NOT scope-highlight when a single session is maximized', () => {
    usePaddock.setState({ selectedProjectId: 'P2', selectedSessionId: 's-run' });
    render(<NodeRow node={NODE} onReorder={noop} onMove={noop} />);
    const row = screen.getByText('beta').closest('.group\\/prow') as HTMLElement;
    expect(row.className).not.toContain('bg-flock-surface-3');
  });
});
