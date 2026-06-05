import { z } from 'zod';
import type { CdpScreencastFrame } from './types.js';

/**
 * Layer C wire framing for the `screencast:<sessionId>` channel (US-27, spec
 * §8.2). Pure, side-effect-free helpers shared by the orchestrator forwarder and
 * (via an identical decoder on the web side) the Browser tab.
 *
 * The shared package already pins the screencast *control* messages
 * (`ScreencastControlMessage` — started/stopped/quality, contracts.ts §8.2).
 * This module adds the per-FRAME payload shape, which is Layer-C-specific and
 * rides the same channel: a small JSON envelope carrying the base64 JPEG plus
 * the CDP frame metadata the client needs to place/scale the image.
 *
 * Keeping it JSON (not raw binary) mirrors how the orchestrator broadcasts other
 * channel frames and lets the web side decode without an out-of-band length
 * header; the JPEG bytes are base64 exactly as chrome hands them to us.
 */

/** WS channel name for a session's screencast stream (spec §8.2). */
export function screencastChannel(sessionId: string): string {
  return `screencast:${sessionId}`;
}

/**
 * The per-frame payload pushed to subscribers of `screencast:<sessionId>`.
 * `data` is the base64 JPEG straight from `Page.screencastFrame`.
 */
export const ScreencastFrameMessage = z.object({
  channel: z.literal('screencast'),
  type: z.literal('frame'),
  sessionId: z.string().min(1),
  /** Base64-encoded JPEG image bytes (as delivered by CDP). */
  data: z.string().min(1),
  /** CDP frame metadata for placing/scaling the image client-side. */
  metadata: z.object({
    offsetTop: z.number(),
    pageScaleFactor: z.number(),
    deviceWidth: z.number(),
    deviceHeight: z.number(),
    scrollOffsetX: z.number(),
    scrollOffsetY: z.number(),
    timestamp: z.number().optional(),
  }),
});
export type ScreencastFrameMessage = z.infer<typeof ScreencastFrameMessage>;

/**
 * Encode a CDP `Page.screencastFrame` event into the `screencast:<id>` wire
 * payload. The CDP `frame.sessionId` is the FRAME ordinal (a number used for
 * acking) and is intentionally NOT serialized — the channel already scopes to
 * the Flock session id, and the ordinal is only meaningful for the ack.
 */
export function encodeScreencastFrame(
  flockSessionId: string,
  frame: CdpScreencastFrame,
): string {
  const message: ScreencastFrameMessage = {
    channel: 'screencast',
    type: 'frame',
    sessionId: flockSessionId,
    data: frame.data,
    metadata: {
      offsetTop: frame.metadata.offsetTop,
      pageScaleFactor: frame.metadata.pageScaleFactor,
      deviceWidth: frame.metadata.deviceWidth,
      deviceHeight: frame.metadata.deviceHeight,
      scrollOffsetX: frame.metadata.scrollOffsetX,
      scrollOffsetY: frame.metadata.scrollOffsetY,
      ...(frame.metadata.timestamp !== undefined
        ? { timestamp: frame.metadata.timestamp }
        : {}),
    },
  };
  return JSON.stringify(message);
}

/** Parse a wire payload back into a {@link ScreencastFrameMessage} (or throw). */
export function decodeScreencastFrame(payload: string): ScreencastFrameMessage {
  return ScreencastFrameMessage.parse(JSON.parse(payload));
}
