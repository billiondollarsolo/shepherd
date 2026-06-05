import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { STATUS_VALUES, ringsSidebar, type Status } from '@flock/shared';
import StatusIndicator from './StatusIndicator';

/**
 * Render ONE indicator and return its element. Each call cleans up the previous
 * render first so loop-based assertions (one per status) never see more than one
 * `status-indicator` in the document (auto-cleanup only fires between `it`s).
 */
function renderIndicator(status: Status): HTMLElement {
  cleanup();
  const { getByTestId } = render(<StatusIndicator status={status} />);
  return getByTestId('status-indicator');
}

afterEach(cleanup);

describe('StatusIndicator (US-23, FR-ST6)', () => {
  it('renders a dot for every status value', () => {
    for (const status of STATUS_VALUES) {
      const el = renderIndicator(status);
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute('data-status', status);
      // dot color token from the flock-theme status.* set
      expect(el.className).toContain(`bg-status-`);
    }
  });

  it('rings only for awaiting_input and error (spec §7 table)', () => {
    for (const status of STATUS_VALUES) {
      const el = renderIndicator(status);
      const ringed = el.getAttribute('data-rings') === 'true';
      // The component's ring decision must match the shared policy exactly.
      expect(ringed).toBe(ringsSidebar(status));
      if (ringed) {
        expect(el.className).toContain('ring-2');
      } else {
        expect(el.className).not.toContain('ring-2');
      }
    }
  });

  it('rings the awaiting_input (money) state with the awaiting token', () => {
    const el = renderIndicator('awaiting_input');
    expect(el).toHaveAttribute('data-rings', 'true');
    expect(el.className).toContain('bg-status-awaiting');
    expect(el.className).toContain('ring-status-awaiting');
  });

  it('rings the error state with the error token', () => {
    const el = renderIndicator('error');
    expect(el).toHaveAttribute('data-rings', 'true');
    expect(el.className).toContain('ring-status-error');
  });

  it('shows idle as a gentle (dimmed) dot with no ring', () => {
    const el = renderIndicator('idle');
    expect(el).toHaveAttribute('data-rings', 'false');
    expect(el.className).toContain('opacity-60');
  });

  it('shows disconnected as a stale (dimmed) dot', () => {
    const el = renderIndicator('disconnected');
    expect(el.className).toContain('bg-status-disconnected');
    expect(el.className).toContain('opacity-60');
  });

  it('exposes an accessible label per status', () => {
    expect(renderIndicator('awaiting_input')).toHaveAttribute('aria-label', 'Awaiting input');
    expect(renderIndicator('error')).toHaveAttribute('aria-label', 'Error');
  });
});
