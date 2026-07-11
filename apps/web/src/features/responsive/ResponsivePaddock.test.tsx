/**
 * US-36 — the layout actually COLLAPSES (FR-UI6, spec line 340).
 *
 * ResponsivePaddock picks the surface from the viewport: the dense desktop
 * paddock (US-30 three-region AppShell) on wide screens, the phone away view on
 * phones. We assert the swap happens by faking the `useIsPhone` decision so the
 * test does not depend on a real media query.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../theme';
import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

// Mock the viewport hook so we control which branch renders.
const isPhoneMock = vi.fn(() => false);
vi.mock('./useIsPhone', () => ({
  useIsPhone: () => isPhoneMock(),
  PHONE_MEDIA_QUERY: '(max-width: 767px)',
}));

// The phone view consumes live sessions; stub the source so the test is offline.
vi.mock('../tree/useStatusWebSocket', () => ({
  useStatusWebSocket: () => ({
    state: 'open',
    statuses: new Map([['s1', 'awaiting_input']]),
  }),
}));

import { ResponsivePaddock } from './ResponsivePaddock';

// The desktop paddock chrome (Sidebar theme toggle) reads the theme context, and
// the store's refresh() calls fetch on mount; provide both so the test is hermetic.
beforeEach(() => {
  usePaddock.setState({
    view: 'overview',
    nodeInfoNodeId: null,
    projectView: 'agents',
    selectedProjectId: null,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://flock.test').pathname;
      const body =
        path === '/api/activity/fleet'
          ? { events: [] }
          : path === '/api/chats/latest'
            ? { chats: {} }
            : path === '/api/teams'
              ? { edges: [] }
              : { nodes: [], projects: [], sessions: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

function renderPaddock(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <ResponsivePaddock />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('ResponsivePaddock (US-36, FR-UI6)', () => {
  it('renders the desktop paddock on a wide viewport', async () => {
    isPhoneMock.mockReturnValue(false);
    renderPaddock();
    expect(await screen.findByTestId('app-shell', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByTestId('phone-view')).toBeNull();
  });

  it('collapses to the phone away view on a narrow viewport', async () => {
    isPhoneMock.mockReturnValue(true);
    renderPaddock();
    expect(await screen.findByTestId('phone-view', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('renders mobile settings inside the shared viewport frame', async () => {
    isPhoneMock.mockReturnValue(true);
    usePaddock.setState({ view: 'settings' });
    renderPaddock();
    expect(await screen.findByTestId('phone-settings', {}, { timeout: 5_000 })).toHaveAttribute(
      'data-mobile-viewport',
    );
    expect(screen.getByLabelText('Settings section')).toBeInTheDocument();
  });

  it('renders mobile node details inside the shared viewport frame', async () => {
    isPhoneMock.mockReturnValue(true);
    usePaddock.setState({ view: 'paddock', nodeInfoNodeId: 'node-1' });
    renderPaddock();
    expect(await screen.findByTestId('phone-node-details', {}, { timeout: 5_000 })).toHaveAttribute(
      'data-mobile-viewport',
    );
  });

  it('renders mobile project Git inside the shared viewport frame', async () => {
    isPhoneMock.mockReturnValue(true);
    usePaddock.setState({
      view: 'paddock',
      projectView: 'git',
      selectedProjectId: 'project-1',
    });
    renderPaddock();
    expect(await screen.findByTestId('phone-project-git', {}, { timeout: 5_000 })).toHaveAttribute(
      'data-mobile-viewport',
    );
  });
});
