/**
 * StatusDot — the ONE session-status indicator dot, used everywhere a session's
 * work status is shown (sidebar, grid, grid tab bar, focus header, bottom bar,
 * node page session list). Renders the shared `.flock-status-dot` element + sets
 * the per-status colour var (the `awaiting_input → awaiting` remap lives here, in
 * one place) and the signature pulse for the "needs you" state.
 *
 * Previously this was re-implemented several ways (a local `Dot` in the sidebar +
 * bare inline `<span className="flock-status-dot">` spans), which let the colour /
 * pulse policy drift. NOTE: the node *connection*-status dot is a different domain
 * (connected/connecting/disconnected) and intentionally not routed through here.
 */
import type { CSSProperties } from 'react';

export interface StatusDotProps {
  /** A session work-status (`StatusEnum`); kept as string so callers don't import the enum just for a dot. */
  status: string;
  /** Emit the signature pulse (the caller decides; typically for `awaiting_input`). */
  pulse?: boolean;
  /** Extra classes (e.g. `shrink-0` inside flex rows). */
  className?: string;
}

export function StatusDot({ status, pulse, className }: StatusDotProps): JSX.Element {
  return (
    <span
      className={`flock-status-dot${pulse ? ' animate-flock-pulse' : ''}${className ? ` ${className}` : ''}`}
      data-status={status}
      style={
        {
          '--flock-indicator-color': `var(--flock-status-${status === 'awaiting_input' ? 'awaiting' : status})`,
        } as CSSProperties
      }
      aria-hidden
    />
  );
}

export default StatusDot;
