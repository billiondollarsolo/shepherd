import { Toaster as Sonner } from 'sonner';

/**
 * Toaster — flock-themed sonner host. Mounted once near the app root. Follows
 * the OS/app theme and the flock elevation/border tokens. Per-type toasts are
 * tinted with the semantic-intent utilities (bg-intent-* / text-intent-*-foreground)
 * so success/warning/danger/info read AA on their fills, and a close button is
 * always offered for keyboard/pointer dismissal.
 */
export function Toaster(): JSX.Element {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group rounded-md border bg-flock-surface-1 text-flock-ink-primary shadow-overlay text-sm',
          description: 'text-flock-ink-muted',
          actionButton: 'bg-flock-accent text-[var(--flock-accent-foreground)]',
          cancelButton: 'bg-flock-surface-2 text-flock-ink-muted',
          closeButton:
            'border-flock-border bg-flock-surface-2 text-flock-ink-muted hover:bg-flock-hover hover:text-flock-ink-primary focus-visible:shadow-focus',
          success: 'border-intent-success bg-intent-success text-intent-success-foreground',
          warning: 'border-intent-warning bg-intent-warning text-intent-warning-foreground',
          error: 'border-intent-danger bg-intent-danger text-intent-danger-foreground',
          info: 'border-intent-info bg-intent-info text-intent-info-foreground',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
