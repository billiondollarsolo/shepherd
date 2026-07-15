import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Badge, Chip } from './badge';

describe('Badge', () => {
  it('renders its content', () => {
    render(<Badge>Ready</Badge>);
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('renders a decorative leading dot when dot is set', () => {
    const { container } = render(<Badge dot>Live</Badge>);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass('bg-current');
  });

  it('applies the small size variant', () => {
    render(<Badge size="sm">Tiny</Badge>);
    expect(screen.getByText('Tiny')).toHaveClass('text-3xs');
  });
});

describe('Chip', () => {
  it('exposes an accessible remove button that fires onRemove', () => {
    const onRemove = vi.fn();
    render(
      <Chip onRemove={onRemove} removeLabel="Remove filter">
        Filter
      </Chip>,
    );
    const button = screen.getByRole('button', { name: 'Remove filter' });
    fireEvent.click(button);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('omits the remove button when no onRemove is given', () => {
    render(<Chip>Static</Chip>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
