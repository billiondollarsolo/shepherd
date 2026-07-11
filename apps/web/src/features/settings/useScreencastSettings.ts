import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS,
  ScreencastBandwidthSettings,
  SCREENCAST_QUALITY_MAX,
  SCREENCAST_QUALITY_MIN,
  type ScreencastBandwidthControlMessage,
  type UnfocusedPolicy,
} from '@flock/shared';

/**
 * US-29 — web settings for the screencast bandwidth controls (NFR-PERF3).
 *
 * The user-facing half of the four controls: adjustable JPEG quality (#3) and
 * the unfocused-pane policy (#2 — pause vs throttle), plus the focus-driven
 * lifecycle that realizes "throttle/pause the unfocused pane" and "on-demand
 * only" (#4) from the browser. The concurrent-stream cap (#1) is a server-side
 * safety limit and is not user-settable here.
 *
 * This hook is pure UI state + a `send` seam (the `screencast:<id>` control
 * channel, wired by the Browser tab). It uses the shared `ScreencastBandwidthSettings`
 * contract — no shape is redefined on the web side.
 */

export interface UseScreencastSettingsOptions {
  sessionId: string;
  /** Sends a control message over the session's `screencast:<id>` channel. */
  send: (msg: ScreencastBandwidthControlMessage) => void;
  /** Whether the Browser tab is currently the visible/open tab (control #4). */
  open: boolean;
  /** Initial user settings (defaults from the shared contract). */
  initial?: ScreencastBandwidthSettings;
}

export interface ScreencastSettingsState {
  quality: number;
  unfocusedPolicy: UnfocusedPolicy;
  /** Live: true when the OS/window has the pane in the foreground. */
  focused: boolean;
}

export interface UseScreencastSettings extends ScreencastSettingsState {
  /** Control #3: set JPEG quality (clamped) and push it live. */
  setQuality: (quality: number) => void;
  /** Control #2: choose how an unfocused pane behaves. */
  setUnfocusedPolicy: (policy: UnfocusedPolicy) => void;
  /** The current user-adjustable settings as the shared contract shape. */
  settings: ScreencastBandwidthSettings;
  qualityMin: number;
  qualityMax: number;
}

function clampQuality(q: number): number {
  return Math.max(SCREENCAST_QUALITY_MIN, Math.min(SCREENCAST_QUALITY_MAX, Math.round(q)));
}

export function useScreencastSettings(opts: UseScreencastSettingsOptions): UseScreencastSettings {
  const { sessionId, send, open, initial } = opts;
  const [quality, setQualityState] = useState<number>(
    initial?.quality ?? DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS.quality,
  );
  const [unfocusedPolicy, setUnfocusedPolicyState] = useState<UnfocusedPolicy>(
    initial?.unfocusedPolicy ?? DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS.unfocusedPolicy,
  );
  const [focused, setFocused] = useState<boolean>(
    typeof document === 'undefined' ? true : !document.hidden,
  );

  // Control #4 (on-demand) — start when the tab opens, stop when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      send({ channel: 'screencast', action: 'start', sessionId });
    } else if (!open && wasOpen.current) {
      send({ channel: 'screencast', action: 'stop', sessionId });
    }
    wasOpen.current = open;
  }, [open, sessionId, send]);

  // Control #2 (throttle/pause unfocused) — drive focus/blur off page visibility
  // so a BACKGROUNDED tab stops consuming bandwidth (NFR-PERF3).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      const isFocused = !document.hidden;
      setFocused(isFocused);
      if (!open) return;
      send({
        channel: 'screencast',
        action: isFocused ? 'focus' : 'blur',
        sessionId,
      });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, sessionId, send]);

  const setQuality = useCallback(
    (q: number) => {
      const clamped = clampQuality(q);
      setQualityState(clamped);
      send({
        channel: 'screencast',
        action: 'quality',
        sessionId,
        quality: clamped,
      });
    },
    [sessionId, send],
  );

  const setUnfocusedPolicy = useCallback(
    (policy: UnfocusedPolicy) => {
      setUnfocusedPolicyState(policy);
      // Re-emit the current focus state so the new policy takes effect now if
      // the pane is already unfocused.
      if (open && !focused) {
        send({ channel: 'screencast', action: 'blur', sessionId });
      }
    },
    [open, focused, sessionId, send],
  );

  const settings: ScreencastBandwidthSettings = ScreencastBandwidthSettings.parse({
    quality,
    unfocusedPolicy,
  });

  return {
    quality,
    unfocusedPolicy,
    focused,
    setQuality,
    setUnfocusedPolicy,
    settings,
    qualityMin: SCREENCAST_QUALITY_MIN,
    qualityMax: SCREENCAST_QUALITY_MAX,
  };
}
