import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders the title as a heading with body and action', () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No sessions"
        description="Start one to begin."
        action={<button type="button">New session</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No sessions' })).toBeInTheDocument();
    expect(screen.getByText('Start one to begin.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument();
  });
});
