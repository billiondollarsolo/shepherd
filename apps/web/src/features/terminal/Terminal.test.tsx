import { render, waitFor, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Terminal, { type XtermLike } from './Terminal';
import type { WsLike } from './usePtyWebSocket';

/** Fake xterm capturing writes + onData handler. */
class FakeXterm implements XtermLike {
  cols = 80;
  rows = 24;
  writes: Array<string | Uint8Array> = [];
  dataCb: ((data: string) => void) | null = null;
  opened = false;
  disposed = false;
  focusCalls = 0;
  open(): void {
    this.opened = true;
  }
  write(data: string | Uint8Array): void {
    this.writes.push(data);
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  loadAddon(): void {}
  focus(): void {
    this.focusCalls += 1;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** Fake WebSocket for the hook. */
class FakeWs implements WsLike {
  binaryType = 'blob';
  readyState = 0;
  sent: Array<string | ArrayBufferView | ArrayBuffer> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | ArrayBufferView | string }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: ArrayBuffer | ArrayBufferView | string): void {
    this.onmessage?.({ data });
  }
}

describe('Terminal (US-12)', () => {
  it('mounts xterm bound to pty:<id> and renders the container', async () => {
    const term = new FakeXterm();
    let socket: FakeWs | undefined;
    const { getByTestId } = render(
      <Terminal
        sessionId="sess-42"
        xtermFactory={() => term}
        wsFactory={(url) => (socket = new FakeWs(url))}
      />,
    );
    expect(getByTestId('terminal')).toBeInTheDocument();
    expect(term.opened).toBe(true);
    // The WS is opened for this session's pty channel.
    await waitFor(() => expect(socket).toBeDefined());
    expect(socket!.url).toContain('/ws/pty/sess-42');
  });

  it('writes inbound PTY output to the terminal (output renders)', async () => {
    const term = new FakeXterm();
    let socket: FakeWs | undefined;
    render(
      <Terminal
        sessionId="s"
        xtermFactory={() => term}
        wsFactory={(url) => (socket = new FakeWs(url))}
      />,
    );
    await waitFor(() => expect(socket).toBeDefined());
    act(() => {
      socket!.open();
      socket!.emit(new Uint8Array([104, 105]).buffer); // "hi"
    });
    expect(term.writes).toHaveLength(1);
    expect(Array.from(term.writes[0] as Uint8Array)).toEqual([104, 105]);
  });

  it('forwards keystrokes upstream so typing echoes', async () => {
    const term = new FakeXterm();
    let socket: FakeWs | undefined;
    render(
      <Terminal
        sessionId="s"
        xtermFactory={() => term}
        wsFactory={(url) => (socket = new FakeWs(url))}
      />,
    );
    await waitFor(() => expect(socket).toBeDefined());
    act(() => socket!.open());
    act(() => term.dataCb!('a'));
    // On open the terminal also sends a resize (JSON string) frame; the keystroke
    // is the binary frame. Assert on the binary frame specifically.
    const binaryFrames = socket!.sent.filter((f) => typeof f !== 'string');
    expect(binaryFrames).toHaveLength(1);
    expect(Array.from(binaryFrames[0] as Uint8Array)).toEqual([97]); // "a"
  });

  it('opens the PTY at the terminal size via the URL — no redundant startup resize', async () => {
    // The PTY is opened at the EXACT grid size carried in the WS URL
    // (?cols=&rows=), so the daemon never starts at 80x24 and needs no startup
    // resize. Sending one anyway makes bash reprint its prompt (and that redraw
    // piles up in the daemon scrollback), so the startup resize must be DEDUPED.
    const term = new FakeXterm();
    term.cols = 142;
    term.rows = 48;
    let socket: FakeWs | undefined;
    render(
      <Terminal
        sessionId="s"
        xtermFactory={() => term}
        wsFactory={(url) => (socket = new FakeWs(url))}
      />,
    );
    // The connect URL carries the real size so the PTY opens at it.
    await waitFor(() => expect(socket).toBeDefined());
    expect(socket!.url).toContain('cols=142');
    expect(socket!.url).toContain('rows=48');

    act(() => socket!.open());
    // eslint-disable-next-line @typescript-eslint/require-await
    await act(async () => {
      await new Promise((r) => setTimeout(r, 90)); // > the 60ms resize debounce
    });
    // No resize frame: the startup size already rode the URL (deduped).
    const resizeFrames = socket!.sent
      .filter((f): f is string => typeof f === 'string')
      .map((f) => JSON.parse(f) as { op?: string })
      .filter((m) => m.op === 'pty:resize');
    expect(resizeFrames).toHaveLength(0);
  });

  it('shows a connecting indicator until the socket opens', async () => {
    const term = new FakeXterm();
    let socket: FakeWs | undefined;
    const { getByTestId, queryByTestId } = render(
      <Terminal
        sessionId="s"
        xtermFactory={() => term}
        wsFactory={(url) => (socket = new FakeWs(url))}
      />,
    );
    expect(getByTestId('terminal-status')).toHaveTextContent('connecting');
    await waitFor(() => expect(socket).toBeDefined());
    act(() => socket!.open());
    await waitFor(() => expect(queryByTestId('terminal-status')).toBeNull());
  });

  it('disposes the terminal on unmount (no leak)', async () => {
    const term = new FakeXterm();
    const { unmount } = render(
      <Terminal sessionId="s" xtermFactory={() => term} wsFactory={(url) => new FakeWs(url)} />,
    );
    unmount();
    // Dispose is deferred to a macrotask so xterm's own open()-scheduled timer
    // fires on a live instance first (StrictMode crash fix); wait a tick.
    await waitFor(() => expect(term.disposed).toBe(true));
  });
});
