import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './checkbox';

describe('Checkbox', () => {
  it('renders with role=checkbox and reflects the unchecked state', () => {
    render(<Checkbox aria-label="Accept" />);
    const box = screen.getByRole('checkbox', { name: 'Accept' });
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles and fires onCheckedChange on click (uncontrolled)', () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox', { name: 'Accept' });
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  it('honours a controlled checked value', () => {
    render(<Checkbox aria-label="Accept" checked />);
    expect(screen.getByRole('checkbox', { name: 'Accept' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
