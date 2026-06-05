import { describe, expect, it, vi } from 'vitest';
import {
  attachShellTerminal,
  type ShellPtySink,
  type TerminalLike,
} from './attachShellTerminal';

function fakeTerminal(cols = 80, rows = 24) {
  const dataHandlers: Array<(d: string) => void> = [];
  const resizeHandlers: Array<(s: { cols: number; rows: number }) => void> = [];
  const dataDispose = vi.fn();
  const resizeDispose = vi.fn();
  const term: TerminalLike = {
    cols,
    rows,
    onData: (h) => {
      dataHandlers.push(h);
      return { dispose: dataDispose };
    },
    onResize: (h) => {
      resizeHandlers.push(h);
      return { dispose: resizeDispose };
    },
  };
  return {
    term,
    dataDispose,
    resizeDispose,
    typeText: (s: string) => dataHandlers.forEach((h) => h(s)),
    resize: (c: number, r: number) =>
      resizeHandlers.forEach((h) => h({ cols: c, rows: r })),
  };
}

function fakePty() {
  const sent: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const pty: ShellPtySink = {
    sendInput: (d) => sent.push(d),
    sendResize: (cols, rows) => resizes.push({ cols, rows }),
  };
  return { pty, sent, resizes };
}

describe('US-35 attachShellTerminal — binds the second shell to the shared ws client', () => {
  it('sends user keystrokes to the PTY', () => {
    const t = fakeTerminal();
    const p = fakePty();
    attachShellTerminal(t.term, p.pty);
    t.typeText('ls\r');
    expect(p.sent).toContain('ls\r');
  });

  it('sends an initial resize matching the terminal size on attach', () => {
    const t = fakeTerminal(100, 30);
    const p = fakePty();
    attachShellTerminal(t.term, p.pty);
    expect(p.resizes[0]).toEqual({ cols: 100, rows: 30 });
  });

  it('does not send an initial resize for an unlaid-out terminal (0x0)', () => {
    const t = fakeTerminal(0, 0);
    const p = fakePty();
    attachShellTerminal(t.term, p.pty);
    expect(p.resizes).toHaveLength(0);
  });

  it('forwards subsequent resize events to the PTY', () => {
    const t = fakeTerminal();
    const p = fakePty();
    attachShellTerminal(t.term, p.pty);
    t.resize(120, 40);
    expect(p.resizes).toContainEqual({ cols: 120, rows: 40 });
  });

  it('disposes both subscriptions on detach', () => {
    const t = fakeTerminal();
    const p = fakePty();
    const detach = attachShellTerminal(t.term, p.pty);
    detach();
    expect(t.dataDispose).toHaveBeenCalledTimes(1);
    expect(t.resizeDispose).toHaveBeenCalledTimes(1);
  });
});
