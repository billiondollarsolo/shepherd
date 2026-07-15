import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Spinner — a calm, size-follows-text loading glyph (Loader2). It inherits the
 * current text color (`text-current`) and font size (`size-[1em]`) so it sits
 * inline with whatever it labels, and announces itself via `role="status"` +
 * `aria-label`. The spin collapses to a still glyph under `prefers-reduced-motion`
 * (the universal reduced-motion block in polish.css neutralizes `animate-spin`).
 */
export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  /** Accessible label announced to assistive tech. Defaults to "Loading". */
  label?: string;
}

export const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, label = 'Loading', ...props }, ref) => (
    <Loader2
      ref={ref}
      role="status"
      aria-label={label}
      className={cn('size-[1em] shrink-0 animate-spin text-current', className)}
      {...props}
    />
  ),
);
Spinner.displayName = 'Spinner';
