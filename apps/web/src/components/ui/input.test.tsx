import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input, Textarea } from './input';

describe('Input validation state', () => {
  it('renders an accessible textbox and reflects aria-invalid', () => {
    render(<Input aria-label="Name" aria-invalid />);
    const field = screen.getByRole('textbox', { name: 'Name' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('is valid by default (no aria-invalid asserted)', () => {
    render(<Input aria-label="Name" />);
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid');
  });
});

describe('Textarea validation state', () => {
  it('renders a textbox and reflects aria-invalid', () => {
    render(<Textarea aria-label="Key" aria-invalid />);
    expect(screen.getByRole('textbox', { name: 'Key' })).toHaveAttribute('aria-invalid', 'true');
  });
});
