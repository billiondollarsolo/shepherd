import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium tracking-label tabular-nums transition-colors',
  {
    variants: {
      variant: {
        neutral: 'border-[var(--flock-border)] bg-flock-surface-2 text-flock-ink-muted',
        accent: 'border-flock-accent/30 bg-flock-accent/10 text-flock-ink-primary',
        success: 'border-status-idle/30 bg-status-idle/10 text-status-idle',
        warning: 'border-status-awaiting/30 bg-status-awaiting/10 text-status-awaiting',
        danger: 'border-status-error/30 bg-status-error/10 text-status-error',
        outline: 'border-[var(--flock-border-strong)] bg-transparent text-flock-ink-muted',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
