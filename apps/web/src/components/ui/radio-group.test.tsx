import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RadioGroup, RadioGroupItem } from './radio-group';

function Fixture({ onValueChange }: { onValueChange?: (v: string) => void }) {
  return (
    <RadioGroup aria-label="Size" onValueChange={onValueChange}>
      <RadioGroupItem value="sm" aria-label="Small" />
      <RadioGroupItem value="md" aria-label="Medium" />
    </RadioGroup>
  );
}

describe('RadioGroup', () => {
  it('exposes radiogroup and radio roles', () => {
    render(<Fixture />);
    expect(screen.getByRole('radiogroup', { name: 'Size' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('selects an item on click', () => {
    const onValueChange = vi.fn();
    render(<Fixture onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Medium' }));
    expect(onValueChange).toHaveBeenCalledWith('md');
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves and selects with ArrowDown', () => {
    render(<Fixture />);
    const small = screen.getByRole('radio', { name: 'Small' });
    fireEvent.click(small);
    fireEvent.keyDown(small, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  });
});
