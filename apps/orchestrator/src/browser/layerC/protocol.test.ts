import { describe, expect, it } from 'vitest';
import {
  ScreencastFrameMessage,
  decodeScreencastFrame,
  encodeScreencastFrame,
  screencastChannel,
} from './protocol.js';
import type { CdpScreencastFrame } from './types.js';

/**
 * US-27 — Layer C wire framing for `screencast:<sessionId>`.
 * Pure helpers; round-trip + channel-name contract pinned here.
 */

const SID = '22222222-2222-4222-8222-222222222222';

const cdpFrame: CdpScreencastFrame = {
  data: 'BASE64JPEGDATA',
  sessionId: 7,
  metadata: {
    offsetTop: 0,
    pageScaleFactor: 1,
    deviceWidth: 800,
    deviceHeight: 600,
    scrollOffsetX: 0,
    scrollOffsetY: 12,
    timestamp: 4242,
  },
};

describe('screencastChannel', () => {
  it('builds the spec §8.2 channel name `screencast:<sessionId>`', () => {
    expect(screencastChannel(SID)).toBe(`screencast:${SID}`);
  });
});

describe('encode/decode screencast frame', () => {
  it('round-trips a CDP frame to the wire payload and back', () => {
    const payload = encodeScreencastFrame(SID, cdpFrame);
    const decoded = decodeScreencastFrame(payload);

    expect(decoded.channel).toBe('screencast');
    expect(decoded.type).toBe('frame');
    expect(decoded.sessionId).toBe(SID);
    expect(decoded.data).toBe('BASE64JPEGDATA');
    expect(decoded.metadata.scrollOffsetY).toBe(12);
    expect(decoded.metadata.timestamp).toBe(4242);
  });

  it('carries the FLOCK session id, never the CDP frame ordinal', () => {
    const decoded = decodeScreencastFrame(encodeScreencastFrame(SID, cdpFrame));
    // The CDP `sessionId: 7` is the ack ordinal and must not leak as the id.
    expect(decoded.sessionId).toBe(SID);
    expect(decoded.sessionId).not.toBe(7 as unknown as string);
  });

  it('omits timestamp when CDP did not supply one', () => {
    const noTs: CdpScreencastFrame = {
      ...cdpFrame,
      metadata: { ...cdpFrame.metadata, timestamp: undefined },
    };
    const decoded = decodeScreencastFrame(encodeScreencastFrame(SID, noTs));
    expect(decoded.metadata.timestamp).toBeUndefined();
  });

  it('rejects a malformed payload', () => {
    expect(() => decodeScreencastFrame('{"channel":"status"}')).toThrow();
    expect(() => ScreencastFrameMessage.parse({ type: 'frame' })).toThrow();
  });
});
