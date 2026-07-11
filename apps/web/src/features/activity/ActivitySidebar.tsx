/**
 * ActivitySidebar — the right activity sidebar (US-34, FR-UI5, spec line 334).
 *
 * Mounts into the US-30 AppShell `activity` slot (see Paddock). It is purely
 * presentational: it takes the single authoritative `Session` record and that
 * session's event log (both from `@flock/shared`) and renders four sections —
 *
 *   1. STATUS TIMELINE   — derived from events, newest-first, each row carrying
 *                          the shared status dot/ring (`StatusIndicator`) so the
 *                          UI never re-decides the spec section 7 status policy.
 *   2. SESSION METADATA   — agent / working dir / tmux session / id; the hook
 *                          token hash is never shown (secret material).
 *   3. NOTE               — a free-text supervisor note for the session.
 *   4. PLAN               — the agent's own task list / to-dos (TodoWrite /
 *                          update_plan), live from the hook stream. (Changed
 *                          files live in the Files tab + Source Control, so they
 *                          aren't duplicated here.)
 *
 * Calm Codex density (Appendix A.4): muted labels, small type, status conveyed
 * by the shared dot rather than loud badges. The whole sidebar is keyed off
 * `@flock/shared` so no domain type or status policy is duplicated.
 */
import { useState } from 'react';

import type { Event, PlanItem, Session, SessionPlan } from '@flock/shared';

import StatusIndicator from '../tree/StatusIndicator.js';
import {
  buildSessionMetadata,
  buildStatusTimeline,
  formatTimelineTimestamp,
} from './activityModel';

export interface ActivitySidebarProps {
  /** The selected session (the single authoritative record), or null. */
  readonly session: Session | null;
  /** That session's event log (write-behind; safe to be empty/stale). */
  readonly events: readonly Event[];
  /** The agent's latest plan/todo snapshot — fills the Plan section. */
  readonly plan?: SessionPlan | null;
  /** Persist a supervisor note for this session (null clears it). When omitted,
   *  the note is shown read-only. */
  readonly onSaveNote?: (note: string | null) => void;
}

function SectionHeading({ children }: { children: string }): JSX.Element {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-flock-muted">
      {children}
    </h3>
  );
}

export function ActivitySidebar({
  session,
  events,
  plan = null,
  onSaveNote,
}: ActivitySidebarProps): JSX.Element {
  return (
    <div className="flex h-full flex-col" data-testid="activity-sidebar">
      <header className="shrink-0 border-b border-flock-muted/15 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Activity</h2>
      </header>

      {session === null ? (
        <div
          data-testid="activity-empty"
          className="flex flex-1 items-center justify-center px-4 py-6 text-center text-sm text-flock-muted"
        >
          Select a session to see its timeline, metadata, and plan.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <ActivityTimeline events={events} />
          <SessionMetadata session={session} />
          <NoteEditor key={session.id} note={session.note} onSave={onSaveNote} />
          <PlanSection plan={plan} />
        </div>
      )}
    </div>
  );
}

function ActivityTimeline({ events }: { events: readonly Event[] }): JSX.Element {
  const timeline = buildStatusTimeline(events);
  return (
    <section className="mb-6">
      <SectionHeading>Status timeline</SectionHeading>
      {timeline.length === 0 ? (
        <p className="text-sm text-flock-muted" data-testid="activity-timeline-empty">
          No status events yet.
        </p>
      ) : (
        <ol data-testid="activity-timeline" className="flex flex-col gap-2">
          {timeline.map((entry) => (
            <li
              key={entry.id}
              data-testid="timeline-entry"
              data-status={entry.status}
              className="flex items-start gap-2 text-sm"
            >
              <StatusIndicator status={entry.status} className="mt-1 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-flock-fg">{entry.status}</span>
                  <time
                    dateTime={entry.ts}
                    className="shrink-0 text-xs tabular-nums text-flock-muted"
                  >
                    {formatTimelineTimestamp(entry.ts)}
                  </time>
                </div>
                {entry.detail ? (
                  <p className="truncate text-xs text-flock-muted">{entry.detail}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionMetadata({ session }: { session: Session }): JSX.Element {
  const rows = buildSessionMetadata(session);
  return (
    <section className="mb-6">
      <SectionHeading>Session</SectionHeading>
      <dl data-testid="activity-metadata" className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline justify-between gap-2 text-sm">
            <dt className="shrink-0 text-flock-muted">{row.label}</dt>
            <dd className="min-w-0 truncate text-right font-mono text-xs text-flock-fg">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A supervisor note for the session — a small textarea that saves on blur (and
 * Cmd/Ctrl+Enter) when the text changed. Read-only when no `onSave` is provided.
 * Local draft state so typing is smooth; reset when the session (key) changes.
 */
function NoteEditor({
  note,
  onSave,
}: {
  note: string | null;
  onSave?: (note: string | null) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(note ?? '');
  // Re-sync the draft when the persisted note changes underneath (refetch / switch)
  // during render rather than a post-paint effect — same result, one fewer render.
  const [syncedNote, setSyncedNote] = useState(note);
  if (note !== syncedNote) {
    setSyncedNote(note);
    setDraft(note ?? '');
  }

  const commit = (): void => {
    if (!onSave) return;
    const next = draft.trim() === '' ? null : draft;
    if (next !== (note ?? null)) onSave(next);
  };

  return (
    <section className="mb-6">
      <SectionHeading>Note</SectionHeading>
      <textarea
        data-testid="session-note-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            commit();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        readOnly={!onSave}
        rows={3}
        placeholder={onSave ? 'What is this session working on?' : 'No note.'}
        className="w-full resize-y rounded border border-flock-muted/25 bg-transparent px-2 py-1.5 text-sm text-flock-fg placeholder:text-flock-muted/60 focus:border-flock-accent focus:outline-none"
      />
    </section>
  );
}

/** Glyph + tailwind tone per plan-item status (calm Codex density). */
const PLAN_MARK: Record<PlanItem['status'], { glyph: string; cls: string }> = {
  completed: { glyph: '✓', cls: 'text-diff-add' },
  in_progress: { glyph: '◐', cls: 'text-flock-accent' },
  pending: { glyph: '○', cls: 'text-flock-muted' },
};

/**
 * The agent's own task list / to-dos (Claude TodoWrite, Codex/Grok update_plan…),
 * live from the hook stream. The unique "what is it doing / how far along" surface
 * — changed files live in the Files tab + Source Control, so they're not repeated
 * here.
 */
function PlanSection({ plan }: { plan: SessionPlan | null }): JSX.Element {
  const planItems = plan?.items ?? [];
  return (
    <section>
      <SectionHeading>Plan</SectionHeading>
      <div data-testid="activity-plan">
        {planItems.length === 0 ? (
          <p className="text-xs text-flock-muted">
            The agent’s task list appears here as it works.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs">
            {planItems.map((item) => {
              const mark = PLAN_MARK[item.status];
              return (
                <li
                  // Key on the todo text, not the index: an item keeps its content
                  // as its status flips pending→completed, so React keeps the right
                  // row identity instead of remounting on reorder/insert.
                  key={item.content}
                  data-status={item.status}
                  className="flex items-start gap-1.5"
                >
                  <span className={`mt-px shrink-0 ${mark.cls}`} aria-hidden>
                    {mark.glyph}
                  </span>
                  <span
                    className={`min-w-0 flex-1 ${
                      item.status === 'completed'
                        ? 'text-flock-muted line-through'
                        : 'text-flock-fg'
                    }`}
                  >
                    {item.content}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
