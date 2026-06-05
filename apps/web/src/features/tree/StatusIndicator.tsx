/**
 * StatusIndicator — the per-session status dot/ring in the tree (US-23, FR-ST6).
 *
 * Codex-calm density (spec Appendix A.4): status is conveyed by a small colored
 * indicator, not a loud badge. The dot color is driven by the `flock-theme`
 * `status.*` tokens (tailwind `bg-status-*`, backed by CSS vars in index.css per
 * spec Appendix A.3). A RING is added only for the two "needs you" states —
 * `awaiting_input` and `error` — sourced from the shared `ringsSidebar()` policy
 * (`@flock/shared`) so the UI never re-decides the spec §7 table:
 *
 *   awaiting_input → ring (the money state)   error → ring
 *   idle           → gentle dot               disconnected → stale (dimmed) dot
 *   starting/running/done → plain dot
 */
import { ringsSidebar, statusLabel, statusPolicy, type Status } from '@flock/shared';

/** Tailwind background class per status — `flock-theme` status.* tokens. */
const DOT_COLOR: Readonly<Record<Status, string>> = {
  starting: 'bg-status-starting',
  running: 'bg-status-running',
  awaiting_input: 'bg-status-awaiting',
  idle: 'bg-status-idle',
  done: 'bg-status-done',
  error: 'bg-status-error',
  disconnected: 'bg-status-disconnected',
};

/** Ring color per status (only consulted when the status rings). */
const RING_COLOR: Readonly<Record<Status, string>> = {
  starting: 'ring-status-starting',
  running: 'ring-status-running',
  awaiting_input: 'ring-status-awaiting',
  idle: 'ring-status-idle',
  done: 'ring-status-done',
  error: 'ring-status-error',
  disconnected: 'ring-status-disconnected',
};

export interface StatusIndicatorProps {
  status: Status;
  /** Extra classes for layout (margins, etc.). */
  className?: string;
}

export default function StatusIndicator({
  status,
  className = '',
}: StatusIndicatorProps): JSX.Element {
  const rings = ringsSidebar(status);
  // `idle` is a gentle dot; `disconnected` is a stale (dimmed) dot.
  const dim = status === 'disconnected' || status === 'idle';

  const classes = [
    'inline-block h-2.5 w-2.5 rounded-full',
    DOT_COLOR[status],
    dim ? 'opacity-60' : '',
    // The ring "demands attention" for awaiting_input/error (spec §7 table).
    rings ? `ring-2 ring-offset-1 ring-offset-flock-bg ${RING_COLOR[status]}` : '',
    // A subtle pulse on the money state draws the eye without being loud.
    status === 'awaiting_input' ? 'animate-pulse' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      data-testid="status-indicator"
      data-status={status}
      data-rings={rings ? 'true' : 'false'}
      data-attention-rank={statusPolicy(status).attentionRank}
      role="img"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={classes}
    />
  );
}
