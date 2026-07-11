import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

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
          'bg-flock-accent text-white shadow-sm hover:bg-[var(--flock-accent-hover)] active:brightness-95',
        secondary:
          'bg-flock-surface-2 text-flock-ink-primary border border-[var(--flock-border)] hover:bg-[var(--flock-surface-hover)]',
        outline:
          'border border-[var(--flock-border-strong)] bg-transparent text-flock-ink-primary hover:bg-[var(--flock-surface-hover)]',
        ghost:
          'bg-transparent text-flock-ink-muted hover:bg-[var(--flock-surface-hover)] hover:text-flock-ink-primary',
        destructive: 'bg-status-error text-white shadow-sm hover:brightness-110',
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
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = 'Button';
