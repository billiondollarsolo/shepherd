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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ nodes: [], projects: [], sessions: [] }), { status: 200 })),
  );
});

function renderPaddock(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ResponsivePaddock />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('ResponsivePaddock (US-36, FR-UI6)', () => {
  it('renders the desktop paddock on a wide viewport', () => {
    isPhoneMock.mockReturnValue(false);
    renderPaddock();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-view')).toBeNull();
  });

  it('collapses to the phone away view on a narrow viewport', () => {
    isPhoneMock.mockReturnValue(true);
    renderPaddock();
    expect(screen.getByTestId('phone-view')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });
});
