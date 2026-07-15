import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Toaster } from './sonner';

describe('Toaster', () => {
  it('mounts the sonner host region', () => {
    const { container } = render(<Toaster />);
    // Sonner renders a section landmark for the toast list.
    expect(container.querySelector('section')).toBeInTheDocument();
  });
});
