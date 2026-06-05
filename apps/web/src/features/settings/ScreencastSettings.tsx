import type {
  ScreencastBandwidthControlMessage,
  UnfocusedPolicy,
} from '@flock/shared';
import { useScreencastSettings } from './useScreencastSettings';

/**
 * US-29 — Screencast bandwidth controls settings panel (NFR-PERF3).
 *
 * The small, calm settings surface inside the Browser tab that exposes the
 * user-adjustable bandwidth controls:
 *   - a JPEG quality slider (control #3), and
 *   - an unfocused-pane policy toggle: PAUSE (zero bandwidth when backgrounded)
 *     vs THROTTLE (a low-rate trickle) — control #2.
 *
 * The concurrent-stream cap (#1) is a server-side safety limit and the on-demand
 * lifecycle (#4) is handled automatically by {@link useScreencastSettings}; both
 * are surfaced here only as read-only status, never as user toggles.
 *
 * Codex-calm density: a single accent, quiet labels, status by small text — not
 * loud badges (spec Appendix A.4).
 */

export interface ScreencastSettingsProps {
  sessionId: string;
  /** Whether the Browser tab is currently open/visible (drives on-demand). */
  open: boolean;
  /** Sends a control message over the session's `screencast:<id>` channel. */
  send: (msg: ScreencastBandwidthControlMessage) => void;
}

export function ScreencastSettings({
  sessionId,
  open,
  send,
}: ScreencastSettingsProps): JSX.Element {
  const s = useScreencastSettings({ sessionId, open, send });

  return (
    <section
      className="flock-screencast-settings"
      aria-label="Screencast bandwidth controls"
      data-testid="screencast-settings"
    >
      <label className="flock-field">
        <span className="flock-field-label">JPEG quality</span>
        <input
          type="range"
          min={s.qualityMin}
          max={s.qualityMax}
          step={1}
          value={s.quality}
          aria-label="JPEG quality"
          onChange={(e) => s.setQuality(Number(e.target.value))}
        />
        <output className="flock-field-value" data-testid="quality-value">
          {s.quality}
        </output>
      </label>

      <fieldset className="flock-field" aria-label="Unfocused pane behavior">
        <legend className="flock-field-label">When backgrounded</legend>
        {(['pause', 'throttle'] as UnfocusedPolicy[]).map((policy) => (
          <label key={policy} className="flock-radio">
            <input
              type="radio"
              name={`unfocused-${sessionId}`}
              value={policy}
              checked={s.unfocusedPolicy === policy}
              onChange={() => s.setUnfocusedPolicy(policy)}
            />
            <span>{policy === 'pause' ? 'Pause (save bandwidth)' : 'Throttle'}</span>
          </label>
        ))}
      </fieldset>

      <p className="flock-field-status" data-testid="focus-status">
        {s.focused ? 'Streaming (focused)' : 'Backgrounded'}
      </p>
    </section>
  );
}
