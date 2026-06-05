import { Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ThemeMode } from './tokens';
import { useTheme } from './useTheme';

/**
 * ThemeSegmented — an explicit Light / Dark / System picker (lucide icons), used
 * in Settings → Appearance. Drives `setMode`, so it persists the choice and, in
 * 'system', live-follows the OS. The single click-to-flip control lives in
 * {@link ThemeToggle}.
 */
const OPTIONS: ReadonlyArray<{ mode: ThemeMode; label: string; Icon: LucideIcon }> = [
  { mode: 'light', label: 'Light', Icon: Sun },
  { mode: 'dark', label: 'Dark', Icon: Moon },
  { mode: 'system', label: 'System', Icon: Monitor },
];

export function ThemeSegmented({ className = '' }: { className?: string }): JSX.Element {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={`inline-flex items-center gap-0.5 rounded-md border border-[var(--flock-border)] bg-flock-surface-2 p-0.5 ${className}`}
    >
      {OPTIONS.map(({ mode: m, label, Icon }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setMode(m)}
            className={[
              'inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:shadow-focus',
              active
                ? 'bg-flock-surface-0 text-flock-ink-primary shadow-sm'
                : 'text-flock-ink-muted hover:text-flock-ink-primary',
            ].join(' ')}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
