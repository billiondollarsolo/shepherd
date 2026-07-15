import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('renders a decorative placeholder on the surface-2 token', () => {
    const { container } = render(<Skeleton data-testid="sk" className="h-4 w-24" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveClass('bg-flock-surface-2', 'animate-pulse');
  });
});
