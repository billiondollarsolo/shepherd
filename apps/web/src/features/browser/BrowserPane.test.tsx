import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import BrowserPane, { type WsLike } from './BrowserPane';

/**
 * US-27 — Layer C Browser pane renders streamed frames; opens the screencast
 * channel on mount (tab open) and stops on unmount (tab switch).
 */

class FakeWs implements WsLike {
  binaryType = 'blob';
  readyState = 0;
  sent: Array<string | ArrayBufferView | ArrayBuffer> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | ArrayBufferView | string }) => void) | null = null;
  closed = false;
  send(d: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: string): void {
    this.onmessage?.({ data });
  }
}

const SID = '66666666-6666-4666-8666-666666666666';

function frameJson(data: string): string {
  return JSON.stringify({
    channel: 'screencast',
    type: 'frame',
    sessionId: SID,
    data,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 800,
      deviceHeight: 600,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  });
}

afterEach(() => cleanup());

describe('BrowserPane (US-27)', () => {
  it('shows a connecting hint before the first frame', () => {
    const ws = new FakeWs();
    render(<BrowserPane sessionId={SID} wsFactory={() => ws} />);
    expect(screen.getByTestId('screencast-status')).toBeTruthy();
  });

  it('renders an inbound frame as a JPEG data: URL on the screencast image', () => {
    const ws = new FakeWs();
    render(<BrowserPane sessionId={SID} wsFactory={() => ws} />);
    act(() => ws.open());
    act(() => ws.message(frameJson('FRAME1')));

    const img = screen.getByTestId('screencast-frame') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,FRAME1');
  });

  it('updates the image as new frames arrive', () => {
    const ws = new FakeWs();
    render(<BrowserPane sessionId={SID} wsFactory={() => ws} />);
    act(() => ws.open());
    act(() => ws.message(frameJson('A')));
    act(() => ws.message(frameJson('B')));
    const img = screen.getByTestId('screencast-frame') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,B');
  });

  it('opens the screencast on mount and stops it on unmount (on-demand)', () => {
    const ws = new FakeWs();
    const { unmount } = render(<BrowserPane sessionId={SID} wsFactory={() => ws} />);
    act(() => ws.open());
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ op: 'open', sessionId: SID });

    act(() => unmount());
    expect(ws.closed).toBe(true);
    expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({
      op: 'close',
      sessionId: SID,
    });
  });
});
