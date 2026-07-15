/**
 * Presentational primitives shared by every settings section, so new sections
 * stay visually consistent as settings grow.
 */
import type { ReactNode } from 'react';

/** A section's title block (header at the top of a settings panel). */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {/* Section titles are semibold so they read as content headings, distinct
            from the bold brand wordmark in the settings sidebar. */}
        <h2 className="font-display text-xl font-semibold tracking-tight text-flock-ink-primary">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-flock-ink-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A labelled setting row: title + description on the left, control on the right. */
export function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-flock-ink-primary">{title}</p>
        {desc && <p className="mt-0.5 text-2xs text-flock-ink-muted">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A bordered card grouping related rows within a section. */
export function SettingCard({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="divide-y divide-[var(--flock-border)] rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-4">
      {children}
    </div>
  );
}
