import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScreencast, type WsLike } from './useScreencast';

/**
 * US-27 — on-demand screencast over `screencast:<id>` (FR-B3, NFR-PERF3).
 *
 * Acceptance pinned here: opening the tab (mount) OPENS the channel and sends the
 * start directive; switching away (unmount) sends the stop directive and CLOSES
 * the socket — so a backgrounded session stops consuming bandwidth. No real
 * socket: a fake WsLike is injected.
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

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
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

const SID = '44444444-4444-4444-8444-444444444444';

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

describe('useScreencast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens the channel ON MOUNT and sends the on-demand start directive', () => {
    const ws = new FakeWs();
    renderHook(() => useScreencast(SID, { onFrame: () => {}, wsFactory: () => ws }));
    act(() => ws.open());
    // The very first upstream message is the open/start directive.
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ op: 'open', sessionId: SID });
  });

  it('delivers decoded frames to onFrame', () => {
    const ws = new FakeWs();
    const frames: string[] = [];
    renderHook(() =>
      useScreencast(SID, {
        onFrame: (f) => frames.push(f.data),
        wsFactory: () => ws,
      }),
    );
    act(() => ws.open());
    act(() => ws.message(frameJson('AAA')));
    act(() => ws.message(frameJson('BBB')));
    expect(frames).toEqual(['AAA', 'BBB']);
  });

  it('ignores malformed / non-frame messages', () => {
    const ws = new FakeWs();
    const frames: string[] = [];
    renderHook(() =>
      useScreencast(SID, { onFrame: (f) => frames.push(f.data), wsFactory: () => ws }),
    );
    act(() => ws.open());
    act(() => ws.message('garbage'));
    act(() => ws.message(JSON.stringify({ channel: 'status' })));
    expect(frames).toEqual([]);
  });

  it('sends the stop directive AND closes the socket on UNMOUNT (tab switch)', () => {
    const ws = new FakeWs();
    const { unmount } = renderHook(() =>
      useScreencast(SID, { onFrame: () => {}, wsFactory: () => ws }),
    );
    act(() => ws.open());
    expect(ws.closed).toBe(false);

    act(() => unmount());

    // Stop directive sent (op:'close') then the socket is closed — no more bandwidth.
    const lastSent = ws.sent[ws.sent.length - 1] as string;
    expect(JSON.parse(lastSent)).toEqual({ op: 'close', sessionId: SID });
    expect(ws.closed).toBe(true);
  });

  it('switching sessions stops the old stream and starts the new one (tab switch)', () => {
    const sockets: FakeWs[] = [];
    const factory = (): WsLike => {
      const w = new FakeWs();
      sockets.push(w);
      return w;
    };
    const { rerender } = renderHook(
      ({ id }) => useScreencast(id, { onFrame: () => {}, wsFactory: factory }),
      { initialProps: { id: SID } },
    );
    act(() => sockets[0].open());

    const OTHER = '55555555-5555-4555-8555-555555555555';
    act(() => rerender({ id: OTHER }));

    // Old socket got the close directive and was closed.
    expect(sockets[0].closed).toBe(true);
    expect(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1] as string)).toEqual({
      op: 'close',
      sessionId: SID,
    });
    // A fresh socket opened for the new session.
    expect(sockets).toHaveLength(2);
    act(() => sockets[1].open());
    expect(JSON.parse(sockets[1].sent[0] as string)).toEqual({
      op: 'open',
      sessionId: OTHER,
    });
  });

  it('reports connection state for a "connecting…" hint', () => {
    const ws = new FakeWs();
    const { result } = renderHook(() =>
      useScreencast(SID, { onFrame: () => {}, wsFactory: () => ws }),
    );
    expect(result.current.state).toBe('connecting');
    act(() => ws.open());
    expect(result.current.state).toBe('open');
  });
});
