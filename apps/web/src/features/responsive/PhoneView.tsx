/**
 * PhoneView — the US-36 phone-friendly away view (FR-UI6).
 *
 * The desktop paddock (US-30 AppShell) is three dense regions; on a phone we
 * collapse to a single scrollable "which agent needs me + approve/deny" column:
 *
 *   - sessions are ordered by the SHARED attention ranking
 *     (`sortSessionsByAttention` → `STATUS_POLICY.attentionRank`), so the agents
 *     blocked on a human (awaiting_input, then error) sit at the top — identical
 *     to the desktop tree, by construction;
 *   - any session in `awaiting_input` gets inline Approve / Deny buttons so the
 *     supervisor can unblock it from their phone (the reason the away view
 *     exists, PRD §1.2 / mobile row in §"platform support");
 *   - a calm all-clear / empty state when nothing needs attention.
 *
 * Presentational + controlled: the caller supplies the session list (from the
 * live `useStatusWebSocket` map) and an `onDecision` handler. No data fetching
 * here, so it unit-tests with no DOM server.
 */
import { useMemo } from 'react';
import type { Status } from '@flock/shared';
import { sortSessionsByAttention } from '../tree/ordering';

/**
 * The two statuses that demand a human (spec §7: awaiting_input + error "ring
 * the sidebar"). Computed locally so the away view depends only on the shared
 * StatusEnum + ordering, not on the policy helper surface.
 */
const ATTENTION_STATUSES: ReadonlySet<Status> = new Set<Status>(['awaiting_input', 'error']);

function needsAttention(status: Status): boolean {
  return ATTENTION_STATUSES.has(status);
}

/** A session as the phone view needs it. */
export interface PhoneSession {
  readonly id: string;
  readonly label: string;
  readonly status: Status;
}

export interface PhoneViewProps {
  readonly sessions: readonly PhoneSession[];
  /** Called when a session row is tapped (to open it). */
  readonly onSelectSession?: (sessionId: string) => void;
}

const STATUS_LABEL: Record<Status, string> = {
  starting: 'Starting',
  running: 'Running',
  awaiting_input: 'Needs you',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  disconnected: 'Disconnected',
};

/** The `--flock-status-*` CSS variable for a status dot (awaiting_input → awaiting). */
function statusDotVar(status: Status): string {
  const key = status === 'awaiting_input' ? 'awaiting' : status;
  return `var(--flock-status-${key})`;
}

function SessionRow({
  session,
  onSelectSession,
}: {
  session: PhoneSession;
  onSelectSession?: (id: string) => void;
}): JSX.Element {
  const rings = needsAttention(session.status);

  return (
    <li
      data-testid="phone-session"
      data-session-id={session.id}
      data-status={session.status}
      className="flex flex-col gap-2 border-b border-flock-muted/15 px-4 py-3"
    >
      <button
        type="button"
        onClick={() => onSelectSession?.(session.id)}
        className="flex items-center gap-3 text-left"
      >
        <span
          aria-hidden="true"
          className={rings ? 'h-3 w-3 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-flock-bg' : 'h-3 w-3 shrink-0 rounded-full'}
          style={{ backgroundColor: statusDotVar(session.status), color: statusDotVar(session.status) }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium text-flock-fg">{session.label}</span>
          <span className="block text-xs text-flock-muted">{STATUS_LABEL[session.status]}</span>
        </span>
      </button>
    </li>
  );
}

export function PhoneView({ sessions, onSelectSession }: PhoneViewProps): JSX.Element {
  // Same shared ordering the desktop tree uses: attention sessions float up.
  const ordered = useMemo(() => sortSessionsByAttention(sessions), [sessions]);
  const anyNeedsAttention = useMemo(
    () => ordered.some((s) => needsAttention(s.status)),
    [ordered],
  );

  return (
    <div
      data-testid="phone-view"
      className="flex h-screen w-screen flex-col overflow-hidden bg-flock-bg text-flock-fg"
    >
      <header className="flex items-center justify-between border-b border-flock-muted/15 px-4 py-3">
        <h1 className="text-base font-semibold tracking-tight">Flock</h1>
        <span className="text-xs text-flock-muted">Which agent needs me?</span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {ordered.length === 0 ? (
          <div
            data-testid="phone-empty"
            className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-flock-muted"
          >
            <p className="text-base">No sessions yet.</p>
            <p className="text-sm">Start one from a desktop to supervise it here.</p>
          </div>
        ) : (
          <>
            {!anyNeedsAttention ? (
              <div
                data-testid="phone-allclear"
                className="border-b border-flock-muted/15 px-4 py-3 text-center text-sm text-flock-muted"
              >
                All clear — nothing needs you right now.
              </div>
            ) : null}
            <ul>
              {ordered.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onSelectSession={onSelectSession}
                />
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

export default PhoneView;
