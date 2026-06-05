import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { KeyboardProvider } from './KeyboardProvider';
import { AppShell } from './AppShell';

/**
 * US-30 — keyboard model (Appendix A.2).
 *  - Cmd/Ctrl+K opens the command palette.
 *  - Cmd/Ctrl+J toggles the bottom shell drawer.
 *
 * KeyboardProvider owns the global key handling and the open/close state; it
 * renders the CommandPalette and the drawer region through AppShell.
 */
function press(key: string, opts: { meta?: boolean; ctrl?: boolean } = {}): void {
  fireEvent.keyDown(window, {
    key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
  });
}

describe('KeyboardProvider (US-30)', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView; some palette interactions use it.
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('opens the command palette on Cmd+K', () => {
    render(
      <KeyboardProvider>
        <AppShell />
      </KeyboardProvider>,
    );
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
    press('k', { meta: true });
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
  });

  it('opens the command palette on Ctrl+K (non-mac)', () => {
    render(
      <KeyboardProvider>
        <AppShell />
      </KeyboardProvider>,
    );
    press('k', { ctrl: true });
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
  });

  it('toggles the bottom shell drawer on Cmd+J', () => {
    render(
      <KeyboardProvider>
        <AppShell />
      </KeyboardProvider>,
    );
    expect(screen.queryByTestId('region-drawer')).not.toBeInTheDocument();
    press('j', { meta: true });
    expect(screen.getByTestId('region-drawer')).toBeInTheDocument();
    press('j', { meta: true });
    expect(screen.queryByTestId('region-drawer')).not.toBeInTheDocument();
  });

  it('closes the command palette on Escape', () => {
    render(
      <KeyboardProvider>
        <AppShell />
      </KeyboardProvider>,
    );
    press('k', { meta: true });
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
  });

  it('does not hijack Cmd+K while typing in an input', () => {
    render(
      <KeyboardProvider>
        <AppShell tree={<input data-testid="text-field" />} />
      </KeyboardProvider>,
    );
    const field = screen.getByTestId('text-field');
    field.focus();
    fireEvent.keyDown(field, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
  });
});
