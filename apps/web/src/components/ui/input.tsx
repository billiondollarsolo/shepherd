import * as React from 'react';
import { cn } from '../../lib/utils';

/** Input — flock-themed text field used across dialogs and settings. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-8 w-full rounded-md border border-[var(--flock-border-strong)] bg-flock-surface-0 px-2.5 text-sm text-flock-ink-primary',
      'placeholder:text-flock-ink-muted shadow-sm transition-shadow duration-fast',
      'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-flock-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'file:border-0 file:bg-transparent file:text-sm file:font-medium',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

/** Textarea — same treatment as Input for multi-line fields (SSH keys etc.). */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[5rem] w-full rounded-md border border-[var(--flock-border-strong)] bg-flock-surface-0 px-2.5 py-2 font-mono text-xs text-flock-ink-primary',
      'placeholder:text-flock-ink-muted shadow-sm transition-shadow duration-fast',
      'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-flock-accent',
      'disabled:cursor-not-allowed disabled:opacity-50 resize-y',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
