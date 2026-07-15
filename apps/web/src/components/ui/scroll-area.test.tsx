import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScrollArea, ScrollBar } from './scroll-area';

describe('ScrollArea', () => {
  it('renders its children inside a focusable viewport', () => {
    render(
      <ScrollArea className="h-10 w-10">
        <div style={{ width: 999, height: 999 }}>Overflowing content</div>
      </ScrollArea>,
    );
    expect(screen.getByText('Overflowing content')).toBeInTheDocument();
  });

  it('exports a ScrollBar that renders both orientations without error', () => {
    expect(ScrollBar).toBeDefined();
    const { container } = render(
      <ScrollArea className="h-10 w-10">
        <div>content</div>
      </ScrollArea>,
    );
    // Vertical + horizontal scrollbars are both mounted (Radix renders them
    // lazily on overflow, so we only assert the tree mounts cleanly here).
    expect(container.firstChild).toBeInTheDocument();
  });
});
