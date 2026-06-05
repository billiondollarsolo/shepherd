import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandPalette } from './CommandPalette';
import type { Command } from './commands';

const commands: Command[] = [
  { id: 'toggle-drawer', title: 'Toggle shell drawer', run: vi.fn() },
  { id: 'toggle-theme', title: 'Toggle theme', run: vi.fn() },
];

describe('CommandPalette (US-30)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    vi.clearAllMocks();
  });

  it('renders as a labelled dialog with a search box when open', () => {
    render(<CommandPalette open commands={commands} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(<CommandPalette open={false} commands={commands} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists all commands and filters as the user types', () => {
    render(<CommandPalette open commands={commands} onClose={() => {}} />);
    expect(screen.getByText('Toggle shell drawer')).toBeInTheDocument();
    expect(screen.getByText('Toggle theme')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drawer' } });
    expect(screen.getByText('Toggle shell drawer')).toBeInTheDocument();
    expect(screen.queryByText('Toggle theme')).not.toBeInTheDocument();
  });

  it('runs the selected command and closes when an item is clicked', () => {
    const onClose = vi.fn();
    render(<CommandPalette open commands={commands} onClose={onClose} />);
    fireEvent.click(screen.getByText('Toggle theme'));
    expect(commands[1].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
