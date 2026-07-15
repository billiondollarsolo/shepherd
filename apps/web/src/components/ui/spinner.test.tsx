import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { Spinner } from './spinner';

afterEach(cleanup);

describe('Spinner', () => {
  it('exposes a status role with a default accessible label', () => {
    const { getByRole } = render(<Spinner />);
    const el = getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'Loading');
  });

  it('spins (animation) so it collapses under prefers-reduced-motion', () => {
    const { getByRole } = render(<Spinner />);
    // size-follows-text + current color so it sits inline with its label.
    const cls = getByRole('status').getAttribute('class') ?? '';
    expect(cls).toContain('animate-spin');
    expect(cls).toContain('text-current');
  });

  it('accepts a custom label', () => {
    const { getByRole } = render(<Spinner label="Saving" />);
    expect(getByRole('status')).toHaveAttribute('aria-label', 'Saving');
  });
});
