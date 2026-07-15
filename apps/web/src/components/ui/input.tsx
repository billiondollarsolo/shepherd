import * as React from 'react';
import { cn } from '../../lib/utils';

// Invalid-state treatment shared by Input + Textarea. Driven entirely by the
// caller setting aria-invalid on the control (FormField/DialogField wire this
// automatically), so validation styling never needs a hand-passed className.
// Uses the status-error token via border-/ring- utilities that already resolve;
// a dedicated --flock-shadow-error token (mirroring --flock-shadow-focus) would
// let the error ring match the focus-ring geometry exactly — see followups.
const invalidState = cn(
  'aria-[invalid=true]:border-status-error aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-status-error',
  'aria-[invalid=true]:focus-visible:border-status-error aria-[invalid=true]:focus-visible:shadow-none',
  'aria-[invalid=true]:focus-visible:ring-2 aria-[invalid=true]:focus-visible:ring-status-error',
);

/** Input — flock-themed text field used across dialogs and settings. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-8 w-full rounded-md border border-strong bg-flock-surface-0 px-2.5 text-sm text-flock-ink-primary',
      'placeholder:text-flock-ink-muted shadow-sm transition-shadow duration-fast',
      'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-flock-accent',
      invalidState,
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
      'flex min-h-[5rem] w-full rounded-md border border-strong bg-flock-surface-0 px-2.5 py-2 font-mono text-xs text-flock-ink-primary',
      'placeholder:text-flock-ink-muted shadow-sm transition-shadow duration-fast',
      'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-flock-accent',
      invalidState,
      'disabled:cursor-not-allowed disabled:opacity-50 resize-y',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
