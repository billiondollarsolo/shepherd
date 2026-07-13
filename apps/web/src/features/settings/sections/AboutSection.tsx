import { GitFork } from 'lucide-react';
import { BuiltBy } from '../../../components/BuiltBy';
import { Badge } from '../../../components/ui';
import { FLOCK_VERSION } from '../../../version';
import { PRODUCT_NAME, PRODUCT_REPOSITORY_URL } from '../../../brand';
import { SectionHeader } from '../SettingsSection';

export const FLOCK_REPOSITORY_URL = PRODUCT_REPOSITORY_URL;

export function AboutSection(): JSX.Element {
  return (
    <div>
      <SectionHeader title="About" />
      <div className="space-y-4 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-5">
        <div className="flex items-center gap-2">
          <span className="font-wordmark text-xl font-semibold">{PRODUCT_NAME}</span>
          <Badge variant="accent">v{FLOCK_VERSION}</Badge>
        </div>
        <p className="max-w-prose text-sm text-flock-ink-muted">
          A web paddock for supervising a flock of CLI coding agents across local and remote nodes.
          Sessions run on the flock-agentd daemon; the orchestrator holds the brains.
        </p>
        <a
          href={FLOCK_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-2 rounded-md border border-[var(--flock-border)] px-3 py-2 text-sm font-medium text-flock-ink-primary transition-colors hover:border-flock-accent/50 hover:bg-flock-surface-2 hover:text-flock-accent"
        >
          <GitFork className="size-4" />
          View {PRODUCT_NAME} on GitHub
        </a>
        <BuiltBy className="text-sm" />
      </div>
    </div>
  );
}
