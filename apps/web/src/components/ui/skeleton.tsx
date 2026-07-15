import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Skeleton — quiet loading placeholder on `bg-flock-surface-2`. The `animate-pulse`
 * shimmer collapses to a static tile under `prefers-reduced-motion` (the global
 * reduced-motion block in polish.css neutralises the animation).
 */
export const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-flock-surface-2', className)}
      {...props}
    />
  ),
);
Skeleton.displayName = 'Skeleton';
