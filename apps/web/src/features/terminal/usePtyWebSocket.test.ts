import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { usePtyWebSocket, type WsLike } from './usePtyWebSocket';

/** A controllable fake WebSocket for driving the hook deterministically. */
class FakeWs implements WsLike {
  binaryType = 'blob';
  readyState = 0; // CONNECTING
  sent: Array<string | ArrayBufferView | ArrayBuffer> = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | ArrayBufferView | string }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  // Test helpers ----------------------------------------------------------
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  emit(data: ArrayBuffer | ArrayBufferView | string): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

describe('usePtyWebSocket', () => {
  it('connects, sets binaryType=arraybuffer, and reports open', async () => {
    let socket: FakeWs | undefined;
    const factory = vi.fn((url: string) => {
      socket = new FakeWs(url);
      return socket;
    });

    const { result } = renderHook(() =>
      usePtyWebSocket('sess-1', { onData: () => {}, wsFactory: factory, reconnect: false }),
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toContain('/ws/pty/sess-1');
    expect(socket!.binaryType).toBe('arraybuffer');
    expect(result.current.state).toBe('connecting');

    act(() => socket!.open());
    await waitFor(() => expect(result.current.state).toBe('open'));
  });

  it('delivers inbound binary frames to onData as bytes', () => {
    const frames: number[][] = [];
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));

    renderHook(() =>
      usePtyWebSocket('s', {
        onData: (b) => frames.push(Array.from(b)),
        wsFactory: factory,
        reconnect: false,
      }),
    );

    act(() => {
      socket!.open();
      socket!.emit(new Uint8Array([104, 105]).buffer); // "hi"
    });
    expect(frames).toEqual([[104, 105]]);
  });

  it('ignores TEXT control frames (does not render JSON acks into the terminal)', () => {
    const frames: number[][] = [];
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));

    renderHook(() =>
      usePtyWebSocket('s', {
        onData: (b) => frames.push(Array.from(b)),
        wsFactory: factory,
        reconnect: false,
      }),
    );

    act(() => {
      socket!.open();
      // A JSON control ack arrives as a TEXT frame — must NOT be written to xterm.
      socket!.emit(JSON.stringify({ channel: 'pty', sessionId: 's', op: 'attached' }));
      socket!.emit(new Uint8Array([97]).buffer); // a real binary output frame
    });
    expect(frames).toEqual([[97]]); // only the binary frame rendered
  });

  it('sends keystrokes as binary frames once open (typing echoes upstream)', () => {
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));

    const { result } = renderHook(() =>
      usePtyWebSocket('s', { onData: () => {}, wsFactory: factory, reconnect: false }),
    );

    // Before open: dropped (no socket OPEN).
    act(() => result.current.sendInput('x'));
    expect(socket!.sent).toHaveLength(0);

    act(() => socket!.open());
    act(() => result.current.sendInput('ls'));
    expect(socket!.sent).toHaveLength(1);
    expect(Array.from(socket!.sent[0] as Uint8Array)).toEqual([108, 115]); // "ls"
  });

  it('sends a JSON resize envelope once open', () => {
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));

    const { result } = renderHook(() =>
      usePtyWebSocket('s', { onData: () => {}, wsFactory: factory, reconnect: false }),
    );
    act(() => socket!.open());
    act(() => result.current.sendResize(120, 40));
    expect(JSON.parse(socket!.sent[0] as string)).toEqual({
      op: 'pty:resize',
      sessionId: 's',
      cols: 120,
      rows: 40,
    });
  });

  it('auto-reconnects after the socket drops (reconnect resumes)', async () => {
    const sockets: FakeWs[] = [];
    const factory = (url: string): FakeWs => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    };
    // Render with real timers so React's effect runs and the first socket
    // connects; only switch to fake timers to deterministically fast-forward
    // the reconnect backoff.
    renderHook(() =>
      usePtyWebSocket('s', { onData: () => {}, wsFactory: factory, reconnect: true }),
    );
    expect(sockets).toHaveLength(1);
    act(() => sockets[0].open());

    vi.useFakeTimers();
    try {
      act(() => sockets[0].drop());
      // Backoff timer elapses → a fresh socket is created.
      act(() => vi.advanceTimersByTime(5_000));
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the socket on unmount and does not reconnect', () => {
    const sockets: FakeWs[] = [];
    const factory = (url: string): FakeWs => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    };
    const { unmount } = renderHook(() =>
      usePtyWebSocket('s', { onData: () => {}, wsFactory: factory, reconnect: true }),
    );
    act(() => sockets[0].open());
    unmount();
    expect(sockets[0].closed).toBe(true);
  });
});
