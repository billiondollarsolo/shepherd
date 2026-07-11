/**
 * BuiltBy — small credit line with links to the builders' public profiles.
 * Used on the auth screen and the sidebar footer.
 */
const PROFILES = [
  { handle: 'mjtechguy', href: 'https://x.com/mjtechguy' },
  { handle: 'blndollarsolo', href: 'https://x.com/blndollarsolo' },
] as const;

const linkClass =
  'font-medium text-flock-ink-muted underline-offset-2 transition-colors hover:text-flock-accent hover:underline';

export interface BuiltByProps {
  className?: string;
  /** Stack vertically (useful in a narrow sidebar). Default is a single line. */
  stacked?: boolean;
}

export function BuiltBy({ className = '', stacked = false }: BuiltByProps): JSX.Element {
  return (
    <p
      className={
        stacked
          ? `flex flex-col gap-0.5 text-2xs leading-snug text-flock-ink-muted/80 ${className}`
          : `text-2xs leading-snug text-flock-ink-muted/80 ${className}`
      }
    >
      <span className={stacked ? '' : 'mr-1'}>Built by</span>
      <span className={stacked ? 'flex flex-wrap gap-x-1.5 gap-y-0.5' : 'inline'}>
        {PROFILES.map((p, i) => (
          <span key={p.handle}>
            {i > 0 && !stacked ? <span className="mx-1 text-flock-ink-muted/50">·</span> : null}
            <a href={p.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
              @{p.handle}
            </a>
          </span>
        ))}
      </span>
    </p>
  );
}
