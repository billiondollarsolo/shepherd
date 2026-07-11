/**
 * Activity sidebar view-model (US-34, FR-UI5).
 *
 * Pure, React-free helpers that project the SHARED `@flock/shared` domain types
 * (`Event`, `Session`, `Status`) into the small view-models the presentational
 * `ActivitySidebar` renders. No domain type is duplicated here — these are
 * view-models derived from the canonical contracts.
 *
 * The right sidebar shows three things (spec line 334):
 *   1. a status TIMELINE derived from the event log,
 *   2. session METADATA,
 *   3. ARTIFACT placeholders, deliberately structured (id/label/hint/items) so
 *      the Phase-2 supervisor agent can fill `items` without reshaping the UI.
 */
import type { Event, Session, Status } from '@flock/shared';

/** Default number of timeline entries to keep (calm density; newest kept). */
export const DEFAULT_TIMELINE_LIMIT = 50;

/**
 * A `running`/`idle` transition that reverts within this window is treated as a
 * transient FLAP (e.g. gemini's PTY-activity heuristic toggling on a brief
 * thinking pause) and suppressed. The "money" states (`awaiting_input`, `error`)
 * are never suppressed — a brief one still matters.
 */
const FLAP_SUPPRESS_MS = 4000;
const FLAPPABLE: ReadonlySet<Status> = new Set<Status>(['running', 'idle']);

/**
 * A single status-timeline entry — a status-bearing `Event` flattened for the
 * UI. `status` is the event's `mappedStatus` narrowed to non-null (only
 * status-bearing events become timeline entries).
 */
export interface StatusTimelineEntry {
  readonly id: string;
  readonly ts: string;
  readonly status: Status;
  readonly source: Event['source'];
  readonly detail: string | null;
}

/**
 * Internal heuristic transitions we never surface to the user: the OSC/PTY
 * fallback (US-20) derives a coarse status from raw terminal ACTIVITY (e.g.
 * "output went quiet → idle") to nudge the status DOT for a session that has no
 * hook/transcript status yet. Those `osc:*` reasons are debug signals, not
 * meaningful agent milestones, and they flap — so they're filtered out of the
 * user-facing timeline (the dot still reflects them live).
 */
function isHeuristicEntry(detail: string | null): boolean {
  return detail != null && detail.startsWith('osc:');
}

/**
 * Builds the status timeline from the event log: keeps only status-bearing
 * events (`mappedStatus !== null`), drops internal heuristic (OSC fallback)
 * transitions, COLLAPSES consecutive same-status runs into one transition,
 * orders newest-first, and caps to `limit` (most-recent entries).
 *
 * Why collapse: the status pipeline records the SAME milestone several times —
 * a raw `hook` row AND its derived `orchestrator` status_transition, repeated
 * PreToolUse/PostToolUse while a tool runs, plus the transcript watcher's own
 * echoes — all mapping to the same status. Rendering each produced visible
 * "duplicate" rows (running / running / running…). A *status* timeline wants the
 * moment the status CHANGED, so we keep the run's start (when the status began)
 * and enrich it with the most specific detail seen in the run (so the row still
 * names the action). A real transition (running → awaiting_input → done) always
 * starts a new entry.
 */
export function buildStatusTimeline(
  events: readonly Event[],
  limit: number = DEFAULT_TIMELINE_LIMIT,
): StatusTimelineEntry[] {
  const chrono = events
    .filter((e): e is Event & { mappedStatus: Status } => e.mappedStatus !== null)
    .filter((e) => !isHeuristicEntry(e.detail))
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      status: e.mappedStatus,
      source: e.source,
      detail: e.detail,
    }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)); // oldest-first to find runs

  // Keep the entry with the more specific detail (so a collapsed run still names
  // the action, e.g. the tool command), preserving the run's START (`into`).
  const withRicherDetail = (into: StatusTimelineEntry, from: StatusTimelineEntry) =>
    (from.detail?.length ?? 0) > (into.detail?.length ?? 0)
      ? { ...into, detail: from.detail }
      : into;

  const out: StatusTimelineEntry[] = [];
  for (const e of chrono) {
    const last = out[out.length - 1];

    // 1) Collapse consecutive same-status echoes (the pipeline records the same
    //    milestone several times — a raw hook row AND its derived transition,
    //    repeated PreToolUse/PostToolUse, transcript-watcher echoes).
    if (last && last.status === e.status) {
      out[out.length - 1] = withRicherDetail(last, e);
      continue;
    }

    // 2) Flap suppression: a brief A → B → A where B is a transient running/idle
    //    blip (gemini's activity heuristic) — drop B and fold this back into A.
    const prev = out[out.length - 2];
    if (
      last &&
      prev &&
      prev.status === e.status &&
      FLAPPABLE.has(last.status) &&
      Date.parse(e.ts) - Date.parse(last.ts) < FLAP_SUPPRESS_MS
    ) {
      out.pop();
      out[out.length - 1] = withRicherDetail(prev, e);
      continue;
    }

    out.push(e);
  }

  return out
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)) // newest-first for display
    .slice(0, Math.max(0, limit));
}

/** A labelled key/value row of session metadata for display. */
export interface SessionMetadataRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * Projects the single authoritative `Session` record into a labelled metadata
 * list. Secret material (the hook token hash) is deliberately NEVER included.
 */
export function buildSessionMetadata(session: Session): SessionMetadataRow[] {
  return [
    { key: 'agentType', label: 'Agent', value: session.agentType },
    { key: 'status', label: 'Status', value: session.status },
    { key: 'workingDir', label: 'Working dir', value: session.workingDir },
    { key: 'sessionId', label: 'Session ID', value: session.id },
  ];
}

/**
 * Renders an ISO-8601 timestamp as a short, locale-stable wall-clock label for
 * a timeline row (e.g. "09:05"). Falls back to the raw string if unparseable.
 */
export function formatTimelineTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
