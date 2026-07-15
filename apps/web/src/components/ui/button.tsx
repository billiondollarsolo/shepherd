import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { Spinner } from './spinner';

/**
 * Button — shadcn-style, themed on the flock-theme tokens (US-31). One confident
 * accent (`primary`), calm neutral surfaces for everything else, and a single
 * focus-ring treatment so the whole paddock feels of-a-piece.
 */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'transition-[background-color,color,box-shadow,opacity] duration-fast ease-standard ' +
    'focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4',
  {
    variants: {
      variant: {
        primary:
          'bg-flock-accent text-[var(--flock-accent-foreground)] shadow-sm hover:bg-flock-accent-hover active:brightness-95',
        secondary:
          'bg-flock-surface-2 text-flock-ink-primary border hover:bg-flock-hover',
        outline:
          'border border-strong bg-transparent text-flock-ink-primary hover:bg-flock-hover',
        ghost:
          'bg-transparent text-flock-ink-muted hover:bg-flock-hover hover:text-flock-ink-primary',
        destructive:
          'bg-intent-danger text-intent-danger-foreground shadow-sm hover:brightness-110',
        link: 'text-flock-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs rounded',
        md: 'h-8 px-3',
        lg: 'h-10 px-5 text-md',
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0 rounded',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Busy state — renders a Spinner, disables the control, and sets `aria-busy`.
   * The label is kept in the layout (opacity-swapped, not removed) so the button
   * never resizes as it flips between idle and busy.
   */
  loading?: boolean;
  /** Optional visible copy shown beside the spinner while `loading` (e.g. "Saving…"). */
  loadingText?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, loadingText, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    // Slot demands a single child, so the busy overlay is only for a real <button>.
    const showLoading = loading && !asChild;
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), showLoading && 'relative', className)}
        disabled={showLoading || disabled}
        aria-busy={showLoading || undefined}
        {...props}
      >
        {showLoading ? (
          <>
            {/* Overlay the spinner so the (opacity-0) label below still reserves width. */}
            <span className="absolute inset-0 flex items-center justify-center gap-2">
              <Spinner aria-hidden={loadingText ? true : undefined} />
              {loadingText}
            </span>
            <span className="opacity-0" aria-hidden="true">
              {children}
            </span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
