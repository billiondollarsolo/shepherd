import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ToggleChip } from './toggle-chip';

describe('ToggleChip', () => {
  it('reflects the selected state via aria-pressed', () => {
    const { rerender } = render(<ToggleChip>Errors</ToggleChip>);
    expect(screen.getByRole('button', { name: 'Errors' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<ToggleChip selected>Errors</ToggleChip>);
    expect(screen.getByRole('button', { name: 'Errors' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onClick when pressed', () => {
    const onClick = vi.fn();
    render(<ToggleChip onClick={onClick}>Errors</ToggleChip>);
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
