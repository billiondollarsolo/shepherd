import { Moon, Sun } from 'lucide-react';
import { forwardRef } from 'react';
import { useTheme } from './useTheme';

export interface ThemeToggleProps {
  className?: string;
}

/**
 * Accessible light/dark toggle — a single icon button that flips the currently
 * visible theme and persists the choice. Uses lucide icons (no emoji). Keeps
 * `data-testid="theme-toggle"` + the "Switch to <next> theme" aria-label for the
 * dual-theme tests (US-31). For an explicit light/dark/system picker, see
 * {@link ThemeSegmented}.
 */
export const ThemeToggle = forwardRef<HTMLButtonElement, ThemeToggleProps>(function ThemeToggle(
  { className = '' },
  ref,
) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const next = resolvedTheme === 'dark' ? 'light' : 'dark';

  const classes = [
    'inline-flex h-7 w-7 items-center justify-center rounded-md',
    'text-flock-ink-muted transition-colors hover:bg-flock-surface-2 hover:text-flock-ink-primary',
    'focus-visible:outline-none focus-visible:shadow-focus',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type="button"
      onClick={toggleTheme}
      data-testid="theme-toggle"
      data-resolved-theme={resolvedTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={classes}
    >
      {resolvedTheme === 'dark' ? (
        <Sun className="size-4" aria-hidden />
      ) : (
        <Moon className="size-4" aria-hidden />
      )}
    </button>
  );
});
