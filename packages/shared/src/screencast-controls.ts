import { z } from 'zod';

/**
 * US-29 — Screencast bandwidth controls (NFR-PERF3).
 *
 * The single, shared, zod-validated contract for the FOUR screencast bandwidth
 * controls (spec §3 "Screencast controls (all in v1)"):
 *   1. cap on concurrent ACTIVE streams,
 *   2. throttle/PAUSE an unfocused pane,
 *   3. adjustable JPEG quality,
 *   4. on-demand only (start on tab open, stop on tab switch — US-27).
 *
 * Lives in `@flock/shared` so BOTH apps import the exact same shapes — the
 * orchestrator's `browser/controls` module applies them, and the web Browser-tab
 * settings UI drives them over the `screencast:<id>` control channel. No control
 * shape is ever duplicated outside this module.
 *
 * Screencast is the known bandwidth bottleneck (spec §14 risk #1); these controls
 * are the v1 mitigation and the WebRTC path is the documented escalation.
 */

/** Bounds for adjustable JPEG quality (CDP `Page.startScreencast` `quality`). */
export const SCREENCAST_QUALITY_MIN = 1;
export const SCREENCAST_QUALITY_MAX = 100;

/**
 * How an UNFOCUSED pane should behave (control #2). A pane is "unfocused" when
 * the Browser tab is not the foreground tab but the user has not fully closed it
 * (e.g. another center tab is active, or the window/PWA is backgrounded).
 *
 *  - `pause`    : stop the CDP screencast entirely → ZERO frames, ZERO bandwidth.
 *  - `throttle` : keep streaming but drop the frame rate (raise `everyNthFrame`)
 *                 and lower JPEG quality → a trickle, not a torrent.
 */
export const UnfocusedPolicy = z.enum(['pause', 'throttle']);
export type UnfocusedPolicy = z.infer<typeof UnfocusedPolicy>;

/**
 * The full, validated bandwidth-control config (NFR-PERF3, all four controls).
 * Defaults favor a calm, low-bandwidth stream; a deploy/user can raise them.
 */
export const ScreencastBandwidthControls = z
  .object({
    /** Control #1 — cap on concurrent ACTIVE streams across all sessions. */
    maxConcurrentStreams: z.number().int().min(1).max(64).default(5),
    /** Control #3 — JPEG quality for a FOCUSED pane (1..100). */
    quality: z
      .number()
      .int()
      .min(SCREENCAST_QUALITY_MIN)
      .max(SCREENCAST_QUALITY_MAX)
      .default(60),
    /** Throttle: send every Nth frame for a FOCUSED pane (1 = every frame). */
    everyNthFrame: z.number().int().min(1).max(60).default(1),
    /** Control #2 — what an UNFOCUSED pane does. */
    unfocusedPolicy: UnfocusedPolicy.default('pause'),
    /**
     * When `unfocusedPolicy === 'throttle'`: the reduced JPEG quality applied to
     * an unfocused pane. Ignored when the policy is `pause`.
     */
    unfocusedQuality: z
      .number()
      .int()
      .min(SCREENCAST_QUALITY_MIN)
      .max(SCREENCAST_QUALITY_MAX)
      .default(20),
    /**
     * When `unfocusedPolicy === 'throttle'`: send every Nth frame for an
     * unfocused pane (a much larger N than the focused value).
     */
    unfocusedEveryNthFrame: z.number().int().min(1).max(120).default(10),
  })
  .strict();
export type ScreencastBandwidthControls = z.infer<
  typeof ScreencastBandwidthControls
>;

/** The canonical defaults (control #4 "on-demand only" is enforced by lifecycle). */
export const DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS: ScreencastBandwidthControls =
  ScreencastBandwidthControls.parse({});

/**
 * The partial, user-adjustable slice the web settings UI sends. The viewport
 * cap is a server-side safety limit and is intentionally NOT user-settable here.
 */
export const ScreencastBandwidthSettings = ScreencastBandwidthControls.pick({
  quality: true,
  everyNthFrame: true,
  unfocusedPolicy: true,
  unfocusedQuality: true,
  unfocusedEveryNthFrame: true,
})
  .partial()
  .strict();
export type ScreencastBandwidthSettings = z.infer<
  typeof ScreencastBandwidthSettings
>;

/**
 * Control messages the web Browser tab sends over the `screencast:<id>` channel
 * to drive the four bandwidth controls live (spec §8.2). (Named distinctly from
 * the legacy `ScreencastControlMessage` stub in contracts.ts so both can coexist
 * through the package barrel; this is the US-29 control envelope.) Discriminated
 * by `action`:
 *
 *  - `start`   : on-demand start (tab opened) — control #4.
 *  - `stop`    : on-demand stop (tab closed) — control #4.
 *  - `focus`   : the pane gained focus → full-rate/quality stream — control #2.
 *  - `blur`    : the pane lost focus → apply `unfocusedPolicy` — control #2.
 *  - `quality` : adjust the focused JPEG quality live — control #3.
 */
export const ScreencastBandwidthControlMessage = z.discriminatedUnion('action', [
  z.object({
    channel: z.literal('screencast'),
    action: z.literal('start'),
    sessionId: z.string().min(1),
  }),
  z.object({
    channel: z.literal('screencast'),
    action: z.literal('stop'),
    sessionId: z.string().min(1),
  }),
  z.object({
    channel: z.literal('screencast'),
    action: z.literal('focus'),
    sessionId: z.string().min(1),
  }),
  z.object({
    channel: z.literal('screencast'),
    action: z.literal('blur'),
    sessionId: z.string().min(1),
  }),
  z.object({
    channel: z.literal('screencast'),
    action: z.literal('quality'),
    sessionId: z.string().min(1),
    quality: z
      .number()
      .int()
      .min(SCREENCAST_QUALITY_MIN)
      .max(SCREENCAST_QUALITY_MAX),
  }),
]);
export type ScreencastBandwidthControlMessage = z.infer<
  typeof ScreencastBandwidthControlMessage
>;

/** Parse an inbound control message off the `screencast:<id>` channel (or throw). */
export function parseScreencastBandwidthControlMessage(
  raw: unknown,
): ScreencastBandwidthControlMessage {
  return ScreencastBandwidthControlMessage.parse(raw);
}
