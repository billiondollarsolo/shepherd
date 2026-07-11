import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Session } from '@flock/shared';

import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

// Shared mutable state the mocks read (hoisted so the vi.mock factories can use it).
const h = vi.hoisted(() => ({
  mounts: {} as Record<string, number>,
  sessions: [] as Session[],
}));

beforeAll(() => {
  // @ts-expect-error minimal stub for jsdom
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

// Terminal mock counts how many times EACH sessionId's terminal is MOUNTED. A
// remount (the "reload all panels" bug) shows up as a count > 1.
vi.mock('../terminal/Terminal', async () => {
  const React = await import('react');
  return {
    default: ({ sessionId }: { sessionId: string }) => {
      React.useEffect(() => {
        h.mounts[sessionId] = (h.mounts[sessionId] ?? 0) + 1;
      }, []);
      return React.createElement('div', { 'data-testid': `term-${sessionId}` });
    },
  };
});
vi.mock('../../data/queries', () => ({
  useSessions: () => ({ data: h.sessions }),
  useProjects: () => ({
    data: [
      {
        id: 'P',
        name: 'proj-P',
        nodeId: 'n',
        workingDir: '/w',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }),
  // GridCell renders TerminalArea (drag-drop upload), which reads this hook.
  useWriteNodeFile: () => ({ mutateAsync: async () => {} }),
}));
vi.mock('./liveData', () => ({
  useLiveStatuses: () => new Map(),
  useAgentdHealth: () => null,
}));

import { GridView } from './GridView';

const render2 = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

function mk(id: string, createdAt: string): Session {
  return {
    id,
    nodeId: 'n',
    projectId: 'P',
    agentType: 'claude-code',
    tmuxSessionName: `flock-${id}`,
    workingDir: '/w',
    browserCdpEndpoint: null,
    hookTokenHash: 'h',
    status: 'running',
    statusDetail: null,
    pinned: false,
    note: null,
    createdAt,
    lastStatusAt: createdAt,
    createdBy: 'u',
    closedAt: null,
  };
}

describe('GridView — adding a pane must not remount existing terminals', () => {
  beforeEach(() => {
    for (const k of Object.keys(h.mounts)) delete h.mounts[k];
  });

  it('keeps existing terminals mounted (no reconnect) when a session is added', async () => {
    h.sessions = [mk('a', '2026-01-01T00:00:00Z'), mk('b', '2026-01-01T00:00:01Z')];
    usePaddock.setState({ selectedSessionId: null, selectedProjectId: 'P', dialog: null });

    const { rerender } = render2(<GridView />);
    await screen.findByTestId('term-a');
    await screen.findByTestId('term-b');
    expect(h.mounts.a).toBe(1);
    expect(h.mounts.b).toBe(1);

    // A new session arrives (as after useCreateSession invalidates the query):
    // a brand-new array with new object identities for ALL sessions.
    h.sessions = [
      mk('a', '2026-01-01T00:00:00Z'),
      mk('b', '2026-01-01T00:00:01Z'),
      mk('c', '2026-01-01T00:00:02Z'),
    ];
    rerender(
      <TooltipProvider>
        <GridView />
      </TooltipProvider>,
    );
    await screen.findByTestId('term-c');

    // The existing two must NOT have remounted (still 1 each); only c is new.
    expect(h.mounts.a).toBe(1);
    expect(h.mounts.b).toBe(1);
    expect(h.mounts.c).toBe(1);
  });

  it('keeps existing panes mounted across the create GAP (new id selected before it is in the cache)', async () => {
    h.sessions = [mk('a', '2026-01-01T00:00:00Z'), mk('b', '2026-01-01T00:00:01Z')];
    usePaddock.setState({ selectedSessionId: null, selectedProjectId: 'P', dialog: null });

    const { rerender } = render2(<GridView />);
    await screen.findByTestId('term-a');
    await screen.findByTestId('term-b');

    // The create flow selects the NEW session id, but the sessions query hasn't
    // refetched yet — so 'c' is selected while the list is still [a, b]. The grid
    // must NOT lose its project scope (which would blank + remount every pane).
    act(() => usePaddock.setState({ selectedSessionId: 'c' }));
    rerender(
      <TooltipProvider>
        <GridView />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('grid-cell-a')).toBeInTheDocument();
    expect(screen.getByTestId('grid-cell-b')).toBeInTheDocument();
    expect(h.mounts.a).toBe(1);
    expect(h.mounts.b).toBe(1);

    // Refetch lands with 'c' present → it appends; a/b still never remounted.
    h.sessions = [
      mk('a', '2026-01-01T00:00:00Z'),
      mk('b', '2026-01-01T00:00:01Z'),
      mk('c', '2026-01-01T00:00:02Z'),
    ];
    rerender(
      <TooltipProvider>
        <GridView />
      </TooltipProvider>,
    );
    await screen.findByTestId('term-c');
    expect(h.mounts.a).toBe(1);
    expect(h.mounts.b).toBe(1);
    expect(h.mounts.c).toBe(1);
  });

  it('does not remount when a new session is inserted out of order (newest first)', async () => {
    h.sessions = [mk('a', '2026-01-01T00:00:00Z'), mk('b', '2026-01-01T00:00:01Z')];
    usePaddock.setState({ selectedSessionId: null, selectedProjectId: 'P', dialog: null });

    const { rerender } = render2(<GridView />);
    await screen.findByTestId('term-a');
    await screen.findByTestId('term-b');

    // Simulate a backend that returns newest-first (would REORDER a naive list).
    h.sessions = [
      mk('c', '2026-01-01T00:00:02Z'),
      mk('a', '2026-01-01T00:00:00Z'),
      mk('b', '2026-01-01T00:00:01Z'),
    ];
    rerender(
      <TooltipProvider>
        <GridView />
      </TooltipProvider>,
    );
    await screen.findByTestId('term-c');

    expect(h.mounts.a).toBe(1);
    expect(h.mounts.b).toBe(1);
    expect(h.mounts.c).toBe(1);
  });
});
