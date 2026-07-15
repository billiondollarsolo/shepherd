import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, CardHeader, CardTitle } from './card';

describe('Card', () => {
  it('renders the surface panel with a header and title', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(container.firstElementChild).toHaveClass('bg-flock-surface-1');
    expect(screen.getByRole('heading', { name: 'Details' })).toBeInTheDocument();
  });
});
