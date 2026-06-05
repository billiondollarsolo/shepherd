import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AppShell } from './AppShell';

/**
 * US-30 — Three-region Codex-style shell.
 *
 * Acceptance criteria asserted here (component level; the keyboard behaviour is
 * driven by KeyboardProvider and asserted in KeyboardProvider.test.tsx, and the
 * Cmd+K / Cmd+J wiring is smoke-tested end-to-end in e2e/shell.spec.ts):
 *  - left node->project->session tree region
 *  - center session pane region
 *  - right activity sidebar region
 *  - a bottom shell drawer region (hidden until toggled)
 *  - stable mount slots so later features (US-32/33/34/35) plug in by region.
 */
describe('AppShell (US-30)', () => {
  it('renders the three primary regions with stable mount slots', () => {
    // The activity region is optional (the Codex side-panel layout omits it); pass
    // it here to assert the full three-region shell.
    render(<AppShell activity={<div />} />);

    // Left: node -> project -> session tree.
    const tree = screen.getByTestId('region-tree');
    expect(tree).toBeInTheDocument();
    expect(tree).toHaveAttribute('data-slot', 'tree');

    // Center: live session pane (terminal | browser | diff land here later).
    const session = screen.getByTestId('region-session');
    expect(session).toBeInTheDocument();
    expect(session).toHaveAttribute('data-slot', 'session');

    // Right: activity sidebar.
    const activity = screen.getByTestId('region-activity');
    expect(activity).toBeInTheDocument();
    expect(activity).toHaveAttribute('data-slot', 'activity');
  });

  it('exposes the three regions as ARIA landmarks for keyboard/AT users', () => {
    render(<AppShell activity={<div />} />);
    // navigation = tree; main = session pane; complementary = activity sidebar.
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('complementary')).toBeInTheDocument();
  });

  it('omits the activity region when no activity is provided (Codex side-panel layout)', () => {
    render(<AppShell tree={<div />} session={<div />} />);
    expect(screen.queryByTestId('region-activity')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    // tree + session still present.
    expect(screen.getByTestId('region-tree')).toBeInTheDocument();
    expect(screen.getByTestId('region-session')).toBeInTheDocument();
  });

  it('keeps the bottom shell drawer closed by default', () => {
    render(<AppShell />);
    expect(screen.queryByTestId('region-drawer')).not.toBeInTheDocument();
  });

  it('renders region children into their slots', () => {
    render(
      <AppShell
        tree={<div data-testid="tree-child">tree</div>}
        session={<div data-testid="session-child">session</div>}
        activity={<div data-testid="activity-child">activity</div>}
      />,
    );
    expect(screen.getByTestId('region-tree')).toContainElement(
      screen.getByTestId('tree-child'),
    );
    expect(screen.getByTestId('region-session')).toContainElement(
      screen.getByTestId('session-child'),
    );
    expect(screen.getByTestId('region-activity')).toContainElement(
      screen.getByTestId('activity-child'),
    );
  });
});
