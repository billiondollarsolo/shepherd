import { ShieldAlert } from 'lucide-react';

export function TransportWarning({
  warning,
  compact = false,
}: {
  readonly warning: string | null | undefined;
  readonly compact?: boolean;
}): JSX.Element | null {
  if (!warning) return null;

  if (compact) {
    return (
      <span
        role="status"
        aria-label={warning}
        title={warning}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-flock-warning/40 bg-flock-warning/10 px-1.5 text-2xs font-medium text-flock-warning"
      >
        <ShieldAlert className="size-3.5" aria-hidden />
        <span className="hidden xl:inline">Private HTTP</span>
      </span>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-flock-warning/40 bg-flock-warning/10 px-3 py-2 text-xs leading-relaxed text-flock-ink-primary"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-flock-warning" aria-hidden />
      <span>{warning}</span>
    </div>
  );
}
