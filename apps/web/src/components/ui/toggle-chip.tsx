import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * ToggleChip — the canonical selectable chip (a `selected` boolean + `size`
 * variants), replacing the three divergent hand-rolled chip idioms. Renders as a
 * toggle button with `aria-pressed`, the shared focus ring, and the accent-soft
 * selected fill.
 */
export const toggleChipVariants = cva(
  'inline-flex select-none items-center gap-1.5 whitespace-nowrap rounded-full border font-medium ' +
    'transition-[background-color,color,border-color,box-shadow] duration-fast ease-standard ' +
    'focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      selected: {
        true: 'border-flock-accent/40 bg-flock-accent-soft text-flock-ink-primary',
        false:
          'border-[var(--flock-border)] bg-flock-surface-2 text-flock-ink-muted hover:bg-flock-hover hover:text-flock-ink-primary',
      },
      size: {
        sm: 'h-6 px-2 text-2xs [&_svg]:size-3',
        md: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
      },
    },
    defaultVariants: { selected: false, size: 'md' },
  },
);

export interface ToggleChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'>,
    VariantProps<typeof toggleChipVariants> {}

export const ToggleChip = React.forwardRef<HTMLButtonElement, ToggleChipProps>(
  ({ className, selected, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-pressed={selected ?? false}
      data-state={selected ? 'on' : 'off'}
      className={cn(toggleChipVariants({ selected, size }), className)}
      {...props}
    />
  ),
);
ToggleChip.displayName = 'ToggleChip';
