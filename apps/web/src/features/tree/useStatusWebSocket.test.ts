import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useStatusWebSocket, type StatusWsLike } from './useStatusWebSocket';

/** A controllable fake WebSocket for driving the hook deterministically. */
class FakeWs implements StatusWsLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
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
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const statusFrame = (sessionId: string, status: string): Record<string, unknown> => ({
  channel: 'status',
  sessionId,
  status,
  detail: null,
  ts: '2026-05-29T06:30:00.000Z',
});

describe('useStatusWebSocket (US-23)', () => {
  it('connects to /ws/status, subscribes on open, and reports open', async () => {
    let socket: FakeWs | undefined;
    const factory = vi.fn((url: string) => {
      socket = new FakeWs(url);
      return socket;
    });

    const { result } = renderHook(() =>
      useStatusWebSocket({ wsFactory: factory, reconnect: false }),
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toContain('/ws/status');
    expect(result.current.state).toBe('connecting');

    act(() => socket!.open());
    await waitFor(() => expect(result.current.state).toBe('open'));
    // Subscribed to the status channel on open.
    expect(JSON.parse(socket!.sent[0])).toEqual({ op: 'subscribe', channel: 'status' });
  });

  it('applies inbound status frames to the per-session map', () => {
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));

    const { result } = renderHook(() =>
      useStatusWebSocket({ wsFactory: factory, reconnect: false }),
    );

    act(() => {
      socket!.open();
      socket!.emit(statusFrame(A, 'running'));
      socket!.emit(statusFrame(B, 'awaiting_input'));
    });

    expect(result.current.statuses.get(A)).toBe('running');
    expect(result.current.statuses.get(B)).toBe('awaiting_input');
  });

  it('updates a session in place on a later transition', () => {
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));
    const { result } = renderHook(() =>
      useStatusWebSocket({ wsFactory: factory, reconnect: false }),
    );

    act(() => {
      socket!.open();
      socket!.emit(statusFrame(A, 'running'));
    });
    expect(result.current.statuses.get(A)).toBe('running');

    act(() => socket!.emit(statusFrame(A, 'awaiting_input')));
    expect(result.current.statuses.get(A)).toBe('awaiting_input');
    expect(result.current.statuses.size).toBe(1);
  });

  it('ignores non-status traffic and malformed frames on the shared socket', () => {
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));
    const { result } = renderHook(() =>
      useStatusWebSocket({ wsFactory: factory, reconnect: false }),
    );

    act(() => {
      socket!.open();
      socket!.emit({ channel: 'nodes', nodeId: A, connectionStatus: 'connected', lastSeenAt: null, ts: '2026-05-29T06:30:00.000Z' });
      socket!.emit('garbage');
      socket!.emit(statusFrame(A, 'idle')); // a real one still lands
    });

    expect(result.current.statuses.size).toBe(1);
    expect(result.current.statuses.get(A)).toBe('idle');
  });

  it('accepts JSON-string frames (as the browser delivers text)', () => {
    let socket: FakeWs | undefined;
    const factory = (url: string): FakeWs => (socket = new FakeWs(url));
    const { result } = renderHook(() =>
      useStatusWebSocket({ wsFactory: factory, reconnect: false }),
    );
    act(() => {
      socket!.open();
      socket!.emit(JSON.stringify(statusFrame(A, 'done')));
    });
    expect(result.current.statuses.get(A)).toBe('done');
  });

  it('auto-reconnects after the socket drops', () => {
    const sockets: FakeWs[] = [];
    const factory = (url: string): FakeWs => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    };
    renderHook(() => useStatusWebSocket({ wsFactory: factory, reconnect: true }));
    expect(sockets).toHaveLength(1);
    act(() => sockets[0].open());

    vi.useFakeTimers();
    try {
      act(() => sockets[0].drop());
      act(() => vi.advanceTimersByTime(5_000));
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the socket on unmount and does not reconnect', () => {
    const sockets: FakeWs[] = [];
    const factory = (url: string): FakeWs => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    };
    const { unmount } = renderHook(() =>
      useStatusWebSocket({ wsFactory: factory, reconnect: true }),
    );
    act(() => sockets[0].open());
    unmount();
    expect(sockets[0].closed).toBe(true);
  });
});
