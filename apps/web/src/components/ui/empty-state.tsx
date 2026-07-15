import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * EmptyState — the canonical "nothing here yet" panel: an icon tile, a
 * `font-display` title, a muted body, and an optional action slot. Replaces the
 * ad-hoc empty layouts scattered across the settings/search/chat surfaces.
 */
export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ icon, title, description, action, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg border border-[var(--flock-border)] bg-flock-surface-2 text-flock-ink-muted [&_svg]:size-5"
        >
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-sm font-semibold tracking-tight text-flock-ink-primary">
          {title}
        </h3>
        {description && <p className="text-xs text-flock-ink-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  ),
);
EmptyState.displayName = 'EmptyState';
