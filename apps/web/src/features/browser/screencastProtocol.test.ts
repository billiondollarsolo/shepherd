import { describe, expect, it } from 'vitest';
import {
  decodeScreencastFrame,
  encodeClose,
  encodeOpen,
  frameToDataUrl,
  screencastChannel,
  screencastWebSocketUrl,
  type ScreencastFrameMessage,
} from './screencastProtocol';

/**
 * US-27 — client-side screencast framing. Pure helpers; no DOM/socket.
 */

const SID = '33333333-3333-4333-8333-333333333333';

const frame: ScreencastFrameMessage = {
  channel: 'screencast',
  type: 'frame',
  sessionId: SID,
  data: 'BASE64JPEG',
  metadata: {
    offsetTop: 0,
    pageScaleFactor: 1,
    deviceWidth: 1024,
    deviceHeight: 768,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  },
};

describe('screencastChannel', () => {
  it('builds the spec §8.2 channel name', () => {
    expect(screencastChannel(SID)).toBe(`screencast:${SID}`);
  });
});

describe('screencastWebSocketUrl', () => {
  it('uses VITE_WS_URL when configured', () => {
    expect(
      screencastWebSocketUrl(SID, { VITE_WS_URL: 'wss://flock.example' }, 'http://x'),
    ).toBe(`wss://flock.example/ws/screencast/${SID}`);
  });

  it('derives ws(s):// from the page origin when not configured', () => {
    expect(screencastWebSocketUrl(SID, {}, 'https://app.local')).toBe(
      `wss://app.local/ws/screencast/${SID}`,
    );
    expect(screencastWebSocketUrl(SID, {}, 'http://app.local')).toBe(
      `ws://app.local/ws/screencast/${SID}`,
    );
  });
});

describe('decodeScreencastFrame', () => {
  it('decodes a well-formed frame', () => {
    const decoded = decodeScreencastFrame(JSON.stringify(frame));
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe('BASE64JPEG');
    expect(decoded!.metadata.deviceWidth).toBe(1024);
  });

  it('returns null for non-frame / malformed payloads (never throws)', () => {
    expect(decodeScreencastFrame('not json')).toBeNull();
    expect(decodeScreencastFrame(JSON.stringify({ channel: 'status' }))).toBeNull();
    expect(decodeScreencastFrame(JSON.stringify({ op: 'started' }))).toBeNull();
  });
});

describe('frameToDataUrl', () => {
  it('builds a renderable data: URL', () => {
    expect(frameToDataUrl(frame)).toBe('data:image/jpeg;base64,BASE64JPEG');
  });
});

describe('open/close control messages (on-demand)', () => {
  it('encodes the open (tab-open → start) directive', () => {
    expect(JSON.parse(encodeOpen(SID))).toEqual({ op: 'open', sessionId: SID });
  });
  it('encodes the close (tab-switch → stop) directive', () => {
    expect(JSON.parse(encodeClose(SID))).toEqual({ op: 'close', sessionId: SID });
  });
});
