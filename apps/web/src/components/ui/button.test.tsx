import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { Button } from './button';

afterEach(cleanup);

describe('Button', () => {
  it('renders an enabled button that is not busy by default', () => {
    const { getByRole } = render(<Button>Save</Button>);
    const btn = getByRole('button');
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(btn).toHaveTextContent('Save');
  });

  it('when loading: disables, sets aria-busy, and shows a status spinner', () => {
    const { getByRole } = render(<Button loading>Save</Button>);
    const btn = getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    // Spinner announces the busy state; the label stays in the DOM (opacity-swapped).
    expect(getByRole('status')).toBeInTheDocument();
    expect(btn).toHaveTextContent('Save');
  });

  it('renders loadingText beside the spinner while loading', () => {
    const { getByRole } = render(
      <Button loading loadingText="Saving…">
        Save
      </Button>,
    );
    expect(getByRole('button')).toHaveTextContent('Saving…');
  });
});
