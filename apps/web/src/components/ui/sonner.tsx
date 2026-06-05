import { Toaster as Sonner } from 'sonner';

/**
 * Toaster — flock-themed sonner host. Mounted once near the app root. Follows
 * the OS/app theme and the flock elevation/border tokens.
 */
export function Toaster(): JSX.Element {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group rounded-md border border-[var(--flock-border)] bg-flock-surface-1 text-flock-ink-primary shadow-overlay text-sm',
          description: 'text-flock-ink-muted',
          actionButton: 'bg-flock-accent text-white',
          cancelButton: 'bg-flock-surface-2 text-flock-ink-muted',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
