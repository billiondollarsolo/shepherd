import { Badge } from '../../../components/ui';
import { SectionHeader } from '../SettingsSection';

export function AboutSection(): JSX.Element {
  return (
    <div>
      <SectionHeader title="About" />
      <div className="space-y-4 rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-5">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight">Flock</span>
          <Badge variant="accent">v1</Badge>
        </div>
        <p className="max-w-prose text-sm text-flock-ink-muted">
          A web paddock for supervising a flock of CLI coding agents across local and
          remote nodes. Sessions run on the flock-agentd daemon; the orchestrator holds the brains.
        </p>
      </div>
    </div>
  );
}
