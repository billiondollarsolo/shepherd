/**
 * US-33 — CenterTabs tests (run under `pnpm test:unit`, jsdom + RTL).
 *
 * Acceptance criteria (FR-UI4):
 *   - the center pane DEFAULTS to Terminal;
 *   - tabs switch to Browser (Layer C) and the read-only Diff;
 *   - only the active panel is mounted (so switching off Browser unmounts the
 *     screencast — NFR-PERF3 on-demand streaming);
 *   - the active session id threads into the mounted panel.
 *
 * Stub components stand in for the real Terminal / BrowserPane / DiffTab so the
 * assertions are about the tab-group wiring only (no xterm/WebSocket/fetch).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CenterTabs } from './CenterTabs';

// Unmount + clear the jsdom document between tests so rendered tab nodes do not
// leak across this file's cases OR into later test files (the web project has no
// global auto-cleanup; mirrors BrowserPane.test.tsx).
afterEach(() => cleanup());

const SESSION_ID = 'sess-123';

function stubs() {
  return {
    Terminal: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="stub-terminal">terminal:{sessionId}</div>
    ),
    BrowserPane: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="stub-browser">browser:{sessionId}</div>
    ),
    DiffTab: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="stub-diff">diff:{sessionId}</div>
    ),
  };
}

describe('CenterTabs (US-33)', () => {
  it('renders all three tabs: Terminal | Browser | Diff', () => {
    render(<CenterTabs sessionId={SESSION_ID} components={stubs()} />);
    expect(screen.getByTestId('center-tab-terminal')).toHaveTextContent('Terminal');
    expect(screen.getByTestId('center-tab-browser')).toHaveTextContent('Browser');
    expect(screen.getByTestId('center-tab-diff')).toHaveTextContent('Diff');
  });

  it('defaults to the Terminal tab and mounts ONLY the terminal panel', () => {
    render(<CenterTabs sessionId={SESSION_ID} components={stubs()} />);

    expect(screen.getByTestId('center-tab-terminal')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('stub-terminal')).toHaveTextContent(`terminal:${SESSION_ID}`);
    // The other panels are NOT mounted until selected.
    expect(screen.queryByTestId('stub-browser')).toBeNull();
    expect(screen.queryByTestId('stub-diff')).toBeNull();
  });

  it('switches to the Browser tab (Layer C) and unmounts the terminal', () => {
    render(<CenterTabs sessionId={SESSION_ID} components={stubs()} />);

    fireEvent.click(screen.getByTestId('center-tab-browser'));

    expect(screen.getByTestId('center-tab-browser')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('stub-browser')).toHaveTextContent(`browser:${SESSION_ID}`);
    // Switching away from Terminal unmounts it.
    expect(screen.queryByTestId('stub-terminal')).toBeNull();
  });

  it('switches to the read-only Diff tab and unmounts the previous panel', () => {
    render(<CenterTabs sessionId={SESSION_ID} components={stubs()} />);

    fireEvent.click(screen.getByTestId('center-tab-browser'));
    fireEvent.click(screen.getByTestId('center-tab-diff'));

    expect(screen.getByTestId('center-tab-diff')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('stub-diff')).toHaveTextContent(`diff:${SESSION_ID}`);
    // Browser panel unmounted (its screencast stops, NFR-PERF3).
    expect(screen.queryByTestId('stub-browser')).toBeNull();
  });

  it('honours an explicit initialTab override', () => {
    render(<CenterTabs sessionId={SESSION_ID} initialTab="diff" components={stubs()} />);
    expect(screen.getByTestId('center-tab-diff')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('stub-diff')).toBeInTheDocument();
  });
});
