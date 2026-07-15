import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Kbd — the canonical keyboard-hint chip (bordered surface chip, mono glyphs).
 * Retires the two divergent inline `<kbd>` styles (TopBar bordered-chip and the
 * `.flock-kbd` rule) so every shortcut hint reads identically.
 */
export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-xs border border-[var(--flock-border)] bg-flock-surface-2 px-1.5 py-0.5',
        'font-mono text-2xs leading-none text-flock-ink-muted',
        className,
      )}
      {...props}
    />
  ),
);
Kbd.displayName = 'Kbd';
