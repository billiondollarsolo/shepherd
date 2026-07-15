import { render, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ResizeSeparator } from './resize-separator';

afterEach(cleanup);

describe('ResizeSeparator', () => {
  it('renders an accessible, focusable separator with orientation + value semantics', () => {
    const { getByRole } = render(
      <ResizeSeparator orientation="vertical" label="Resize panel" value={40} min={5} max={95} />,
    );
    const sep = getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-label', 'Resize panel');
    expect(sep).toHaveAttribute('aria-valuenow', '40');
    expect(sep).toHaveAttribute('aria-valuemin', '5');
    expect(sep).toHaveAttribute('aria-valuemax', '95');
    // Keyboard-reachable.
    expect(sep).toHaveAttribute('tabindex', '0');
  });

  it('steps the value with arrow keys (vertical: Left/Right), clamped to min/max', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(
      <ResizeSeparator
        orientation="vertical"
        value={50}
        min={5}
        max={95}
        step={10}
        onValueChange={onValueChange}
      />,
    );
    const sep = getByRole('separator');

    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenLastCalledWith(60);

    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onValueChange).toHaveBeenLastCalledWith(40);

    // Home / End jump to the bounds.
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(onValueChange).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(onValueChange).toHaveBeenLastCalledWith(95);
  });

  it('uses Up/Down arrows for a horizontal separator', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(
      <ResizeSeparator
        orientation="horizontal"
        value={50}
        min={0}
        max={100}
        step={5}
        onValueChange={onValueChange}
      />,
    );
    const sep = getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal');

    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(onValueChange).toHaveBeenLastCalledWith(55);
    fireEvent.keyDown(sep, { key: 'ArrowUp' });
    expect(onValueChange).toHaveBeenLastCalledWith(45);
    // Cross-axis arrows are ignored on a horizontal handle.
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });

  it('resets on double-click and Enter', () => {
    const onReset = vi.fn();
    const { getByRole } = render(<ResizeSeparator value={50} onReset={onReset} />);
    const sep = getByRole('separator');
    fireEvent.doubleClick(sep);
    fireEvent.keyDown(sep, { key: 'Enter' });
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('is inert when disabled (not focusable, no stepping)', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(
      <ResizeSeparator value={50} step={10} disabled onValueChange={onValueChange} />,
    );
    const sep = getByRole('separator');
    expect(sep).toHaveAttribute('tabindex', '-1');
    expect(sep).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
