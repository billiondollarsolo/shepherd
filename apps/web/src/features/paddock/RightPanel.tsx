/**
 * RightPanel — the workspace context panel beside the always-on terminal. After
 * the adaptive-workspace redesign it presents THREE clear contexts instead of six
 * flat tabs:
 *   • Talk — the conversation (Chat) + Activity timeline/plan
 *   • Code — Source Control (diff), Files, Find-in-Files
 *   • Web  — the session browser
 * Each context keeps its sub-views; the store's `rightTab` is still the active
 * leaf, so adaptive surfacing (SessionPane) just calls openRight(<leaf>).
 */
import { Activity, ChevronRight, Code2, FolderTree, GitBranch, Globe, MessageSquare, Search, type LucideIcon } from 'lucide-react';
import type { Session } from '@flock/shared';
import { ChatPanel } from '../chat/ChatPanel';
import BrowserPane from '../browser/BrowserPane';
import SourceControlPanel from '../center/SourceControlPanel';
import FilesPanel from '../files/FilesPanel';
import SearchPanel from '../search/SearchPanel';
import { ActivitySidebar } from '../activity';
import { SimpleTooltip } from '../../components/ui';
import { usePaddock, type RightTab } from '../../store/paddock';
import { useSessionEvents, useSessionPlan, useUpdateSession } from '../../data/queries';

interface SubTab {
  id: RightTab;
  label: string;
  icon: LucideIcon;
}
interface Context {
  id: string;
  label: string;
  icon: LucideIcon;
  tabs: SubTab[];
}

/** The 3 workspace contexts and their sub-views (in order). */
const CONTEXTS: ReadonlyArray<Context> = [
  {
    id: 'talk',
    label: 'Talk',
    icon: MessageSquare,
    tabs: [
      { id: 'chat', label: 'Chat', icon: MessageSquare },
      { id: 'activity', label: 'Activity', icon: Activity },
      { id: 'notes', label: 'Notes', icon: Activity },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    icon: Code2,
    tabs: [
      { id: 'diff', label: 'Source Control', icon: GitBranch },
      { id: 'files', label: 'Files', icon: FolderTree },
      { id: 'search', label: 'Find', icon: Search },
    ],
  },
  { id: 'web', label: 'Web', icon: Globe, tabs: [{ id: 'browser', label: 'Browser', icon: Globe }] },
];

/** Leaf tab → its context. */
function contextOf(tab: RightTab): Context {
  return CONTEXTS.find((c) => c.tabs.some((t) => t.id === tab)) ?? CONTEXTS[0]!;
}
/** A context's default leaf (what clicking the context opens). */
export function primaryTab(contextId: string): RightTab {
  return (CONTEXTS.find((c) => c.id === contextId) ?? CONTEXTS[0]!).tabs[0]!.id;
}

/**
 * RightRail — the COLLAPSED panel: a thin vertical bar of the 3 context icons.
 * Clicking one expands the panel straight to that context's primary view.
 */
export function RightRail(): JSX.Element {
  const tab = usePaddock((s) => s.rightTab);
  const openRight = usePaddock((s) => s.openRight);
  const activeCtx = contextOf(tab).id;
  return (
    <div
      className="flex h-full w-9 shrink-0 flex-col items-center gap-1 border-l border-[var(--flock-border)] bg-flock-surface-1 py-2"
      data-testid="right-rail"
    >
      {CONTEXTS.map((c) => {
        const Icon = c.icon;
        return (
          <SimpleTooltip key={c.id} label={c.label} side="left">
            <button
              type="button"
              onClick={() => openRight(c.tabs[0]!.id)}
              aria-label={c.label}
              data-testid={`right-rail-${c.id}`}
              className={`rounded-md p-1.5 transition-colors ${
                activeCtx === c.id
                  ? 'bg-flock-accent/15 text-flock-accent ring-1 ring-flock-accent/30'
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
  const ctx = contextOf(tab);
  // Live data only fetched while the Activity sub-view is showing.
  const { data: events = [] } = useSessionEvents(tab === 'activity' ? session.id : null);
  const { data: plan } = useSessionPlan(tab === 'activity' ? session.id : null);
  const updateSession = useUpdateSession();

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--flock-border)] bg-flock-surface-1">
      {/* Context row: Talk / Code / Web */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--flock-border)] px-1.5">
        {CONTEXTS.map((c) => {
          const Icon = c.icon;
          const active = ctx.id === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => openRight(c.tabs[0]!.id)}
              aria-selected={active}
              data-testid={`right-context-${c.id}`}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'bg-flock-accent/15 text-flock-accent'
                  : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
              }`}
            >
              <Icon className="size-3.5" /> {c.label}
            </button>
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

      {/* Sub-tabs (only when the active context has more than one view) */}
      {ctx.tabs.length > 1 ? (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--flock-border)] px-1.5">
          {ctx.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => openRight(t.id)}
              aria-selected={tab === t.id}
              data-testid={`right-tab-${t.id}`}
              className={`rounded px-2 py-0.5 text-2xs transition-colors ${
                tab === t.id
                  ? 'bg-flock-surface-2 text-flock-ink-primary'
                  : 'text-flock-ink-muted hover:text-flock-ink-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'chat' ? <ChatPanel key={session.id} session={session} /> : null}
        {tab === 'activity' ? (
          <ActivitySidebar
            session={session}
            events={events}
            plan={plan ?? null}
            onSaveNote={(note) => updateSession.mutate({ id: session.id, patch: { note } })}
          />
        ) : null}
        {tab === 'notes' ? (
          <div className="flex h-full flex-col gap-2 p-3" data-testid="session-notes">
            <p className="text-2xs font-semibold uppercase tracking-wide text-flock-ink-muted">
              Notes (markdown)
            </p>
            <textarea
              className="min-h-0 flex-1 resize-none rounded border border-[var(--flock-border)] bg-flock-bg p-2 font-mono text-xs text-flock-ink-primary"
              defaultValue={session.note ?? ''}
              placeholder="Supervisor notes for this agent…"
              onBlur={(e) => {
                const next = e.target.value;
                if (next !== (session.note ?? '')) {
                  updateSession.mutate({ id: session.id, patch: { note: next || null } });
                }
              }}
            />
          </div>
        ) : null}
        {tab === 'files' ? <FilesPanel key={session.id} session={session} /> : null}
        {tab === 'search' ? <SearchPanel key={session.id} session={session} /> : null}
        {tab === 'browser' ? <BrowserPane key={session.id} sessionId={session.id} /> : null}
        {tab === 'diff' ? <SourceControlPanel key={session.id} sessionId={session.id} /> : null}
      </div>
    </div>
  );
}
