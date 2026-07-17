import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border font-medium tracking-label tabular-nums transition-colors',
  {
    variants: {
      variant: {
        neutral: 'bg-flock-surface-2 text-flock-ink-muted',
        accent: 'border-flock-accent/30 bg-flock-accent/10 text-flock-ink-primary',
        success: 'border-status-idle/40 bg-status-idle/10 text-flock-ink-primary',
        warning: 'border-status-awaiting/40 bg-status-awaiting/10 text-flock-ink-primary',
        danger: 'border-status-error/40 bg-status-error/10 text-flock-ink-primary',
        outline: 'border-strong bg-transparent text-flock-ink-muted',
      },
      size: {
        sm: 'px-1.5 py-0 text-3xs',
        md: 'px-2 py-0.5 text-2xs',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'md' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Render a leading status dot inheriting the badge's text colour. */
  dot?: boolean;
}

export function Badge({
  className,
  variant,
  size,
  dot,
  children,
  ...props
}: BadgeProps): JSX.Element {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Fired when the trailing remove button is activated. */
  onRemove?: () => void;
  /** Accessible label for the remove button (defaults to "Remove"). */
  removeLabel?: string;
  /** Render a leading status dot inheriting the chip's text colour. */
  dot?: boolean;
}

/**
 * Chip — a removable Badge. Renders the same token-driven pill as Badge with a
 * trailing button carrying an `x`; the button is keyboard-focusable and exposes
 * an accessible label so it works for AT users.
 */
export function Chip({
  className,
  variant,
  size,
  dot,
  onRemove,
  removeLabel = 'Remove',
  children,
  ...props
}: ChipProps): JSX.Element {
  return (
    <span className={cn(badgeVariants({ variant, size }), 'pr-1', className)} {...props}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className={cn(
            'ml-0.5 -mr-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full opacity-70',
            'transition-[opacity,background-color] hover:bg-flock-hover hover:opacity-100 focus:outline-none focus-visible:shadow-focus',
          )}
        >
          <X className="size-2.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
