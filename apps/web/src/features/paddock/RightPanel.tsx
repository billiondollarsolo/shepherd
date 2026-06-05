/**
 * RightPanel — the Codex-style side panel that opens to the RIGHT of the always-on
 * terminal: Browser / Diff / Activity as tabs. Only the active tab is mounted, so
 * switching away from Browser stops the screencast and switching to Diff refetches
 * (mirrors the old CenterTabs semantics, now beside the terminal instead of over it).
 */
import { Activity, ChevronRight, FolderTree, GitBranch, Globe, Search, type LucideIcon } from 'lucide-react';
import type { Session } from '@flock/shared';
import BrowserPane from '../browser/BrowserPane';
import SourceControlPanel from '../center/SourceControlPanel';
import FilesPanel from '../files/FilesPanel';
import SearchPanel from '../search/SearchPanel';
import { ActivitySidebar } from '../activity';
import { SimpleTooltip } from '../../components/ui';
import { usePaddock, type RightTab } from '../../store/paddock';
import { useSessionEvents, useSessionPlan, useUpdateSession } from '../../data/queries';

// Icon-only tabs (Orca-style). Labels stay for aria/tooltips, not on screen.
const TABS: ReadonlyArray<{ id: RightTab; label: string; icon: LucideIcon }> = [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'search', label: 'Find in Files', icon: Search },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'diff', label: 'Source Control', icon: GitBranch },
];

/**
 * RightRail — the COLLAPSED form of the right panel: a thin vertical icon bar
 * (VS Code activity-bar style). Each icon has a tooltip; clicking it expands the
 * panel straight to that tab. Shown by SessionPane when the panel is collapsed.
 */
export function RightRail(): JSX.Element {
  const tab = usePaddock((s) => s.rightTab);
  const openRight = usePaddock((s) => s.openRight);
  return (
    <div
      className="flex h-full w-9 shrink-0 flex-col items-center gap-1 border-l border-[var(--flock-border)] bg-flock-surface-1 py-2"
      data-testid="right-rail"
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <SimpleTooltip key={t.id} label={t.label} side="left">
            <button
              type="button"
              onClick={() => openRight(t.id)}
              aria-label={t.label}
              data-testid={`right-rail-${t.id}`}
              className={`rounded p-1.5 ${
                tab === t.id
                  ? 'text-flock-accent'
                  : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
              }`}
            >
              <Icon className="size-4" />
            </button>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}

export function RightPanel({ session }: { session: Session }): JSX.Element {
  const tab = usePaddock((s) => s.rightTab);
  const openRight = usePaddock((s) => s.openRight);
  const toggleRight = usePaddock((s) => s.toggleRight);
  // Live-tailed event log for the Activity timeline (only fetched while shown).
  const { data: events = [] } = useSessionEvents(tab === 'activity' ? session.id : null);
  // The agent's plan feeds the Activity "Plan" section (only fetched while shown).
  const { data: plan } = useSessionPlan(tab === 'activity' ? session.id : null);
  const updateSession = useUpdateSession();

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--flock-border)] bg-flock-surface-1">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--flock-border)] px-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <SimpleTooltip key={t.id} label={t.label}>
              <button
                type="button"
                onClick={() => openRight(t.id)}
                aria-selected={tab === t.id}
                aria-label={t.label}
                data-testid={`right-tab-${t.id}`}
                className={`rounded p-1.5 ${
                  tab === t.id
                    ? 'bg-flock-surface-2 text-flock-accent'
                    : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
                }`}
              >
                <Icon className="size-4" />
              </button>
            </SimpleTooltip>
          );
        })}
        <button
          type="button"
          onClick={toggleRight}
          aria-label="Collapse panel"
          title="Collapse panel"
          className="ml-auto rounded px-1.5 py-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'activity' ? (
          <ActivitySidebar
            session={session}
            events={events}
            plan={plan ?? null}
            onSaveNote={(note) => updateSession.mutate({ id: session.id, patch: { note } })}
          />
        ) : null}
        {tab === 'files' ? <FilesPanel key={session.id} session={session} /> : null}
        {tab === 'search' ? <SearchPanel key={session.id} session={session} /> : null}
        {tab === 'browser' ? <BrowserPane key={session.id} sessionId={session.id} /> : null}
        {tab === 'diff' ? <SourceControlPanel key={session.id} sessionId={session.id} /> : null}
      </div>
    </div>
  );
}
