/**
 * US-11 — PtySession unit tests (run under `pnpm test:unit`).
 *
 * These verify the core of the PTY ⇄ WebSocket bridge WITHOUT real tmux or real
 * sockets, using a fake {@link NodeTransport} whose `openPty` returns a
 * controllable {@link FakePtyHandle}. They assert the acceptance criteria that
 * are pure logic:
 *   - two subscribers attached to ONE session BOTH receive output (FR-S6),
 *   - input from a client is forwarded INTO the single shared PTY,
 *   - the PTY is opened ONCE and shared (not per-subscriber),
 *   - reconnect RESUMES from the recent-output ring buffer (US-11),
 *   - the shared PTY is opened lazily and detached when the last client leaves,
 *   - detach does NOT mean kill-the-agent — it only ends the attach client.
 *
 * Real tmux behaviour (the actual stream + reconnect over `ws`) is covered by
 * pty-ws.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  ExecOptions,
  ExecResult,
  NodeTransport,
  OpenPtyOptions,
  PtyExit,
  PtyHandle,
} from '../../nodes/transport/transport.js';
import { PtySession } from './pty-session.js';

/** A controllable in-memory PTY: tests push output and observe writes. */
class FakePtyHandle implements PtyHandle {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private exited: PtyExit | null = null;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(e: PtyExit) => void>();

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExit) => void): () => void {
    if (this.exited) {
      const recorded = this.exited;
      queueMicrotask(() => listener(recorded));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  /** Test helper: emit output to all current subscribers. */
  emit(chunk: string): void {
    for (const l of [...this.dataListeners]) l(chunk);
  }

  /** Test helper: simulate the program exiting. */
  exit(event: PtyExit = { exitCode: 0, signal: null }): void {
    this.exited = event;
    for (const l of [...this.exitListeners]) l(event);
    this.exitListeners.clear();
  }
}

/** A transport whose openPty hands back fakes; records how many were opened. */
class FakeTransport implements NodeTransport {
  readonly kind = 'local' as const;
  readonly ptys: FakePtyHandle[] = [];
  openPtyCalls: OpenPtyOptions[] = [];

  async exec(_command: string[], _options?: ExecOptions): Promise<ExecResult> {
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  }

  async openPty(options: OpenPtyOptions = {}): Promise<PtyHandle> {
    this.openPtyCalls.push(options);
    const pty = new FakePtyHandle();
    this.ptys.push(pty);
    return pty;
  }

  async dispose(): Promise<void> {}
}

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ATTACH = (): string[] => ['tmux', 'attach-session', '-t', `flock-${SESSION_ID}`];

function makeSession(transport: NodeTransport, resumeBufferBytes?: number): PtySession {
  return new PtySession({
    sessionId: SESSION_ID,
    transport,
    attachCommand: ATTACH,
    workingDir: '/w',
    resumeBufferBytes,
  });
}

/** Collects bytes a subscriber receives, joined as utf-8. */
function collector(): { sub: { onData(c: Buffer): void; onExit(e: PtyExit): void }; text(): string; exits: PtyExit[] } {
  const chunks: Buffer[] = [];
  const exits: PtyExit[] = [];
  return {
    sub: {
      onData: (c: Buffer) => chunks.push(c),
      onExit: (e: PtyExit) => exits.push(e),
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    exits,
  };
}

describe('PtySession — shared single attachment (US-11, FR-S6)', () => {
  it('opens the PTY exactly once and runs the attach argv in the working dir', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);

    expect(transport.openPtyCalls).toHaveLength(1);
    expect(transport.openPtyCalls[0]!.command).toEqual(ATTACH());
    expect(transport.openPtyCalls[0]!.cwd).toBe('/w');
    expect(transport.ptys).toHaveLength(1);
  });

  it('fans output out to TWO concurrent subscribers (both see the same bytes)', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const a = collector();
    const b = collector();
    await session.subscribe(a.sub);
    await session.subscribe(b.sub);

    // Still ONE shared PTY for both clients.
    expect(transport.ptys).toHaveLength(1);
    expect(session.subscriberCount).toBe(2);

    transport.ptys[0]!.emit('hello world\n');

    expect(a.text()).toBe('hello world\n');
    expect(b.text()).toBe('hello world\n');
  });

  it('forwards input from a client INTO the single shared PTY', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);

    await session.write('ls -la\r');
    await session.write(Buffer.from('q'));

    expect(transport.ptys[0]!.writes).toEqual(['ls -la\r', 'q']);
  });

  it('RESUMES a (re)connecting subscriber from the recent-output ring buffer', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const first = collector();
    const firstSub = await session.subscribe(first.sub);
    transport.ptys[0]!.emit('line-1\n');
    transport.ptys[0]!.emit('line-2\n');

    // First client "disconnects".
    firstSub.close();
    expect(session.subscriberCount).toBe(0);

    // A reconnecting client must immediately receive the recent backlog so the
    // terminal is not blank (US-11 "reconnect resumes").
    const reconnected = collector();
    await session.subscribe(reconnected.sub);
    expect(reconnected.text()).toBe('line-1\nline-2\n');
  });

  it('does not replay output produced AFTER the buffer is trimmed past capacity', async () => {
    const transport = new FakeTransport();
    // Tiny buffer: only the most recent ~8 bytes survive.
    const session = makeSession(transport, 8);
    await session.subscribe(collector().sub);

    transport.ptys[0]!.emit('AAAAAAAAAA'); // 10 bytes, exceeds cap
    transport.ptys[0]!.emit('BBBB');

    const late = collector();
    await session.subscribe(late.sub);
    // Whatever survives must be a SUFFIX of the produced stream and within cap.
    const resumed = late.text();
    expect(resumed.length).toBeLessThanOrEqual(8);
    expect('AAAAAAAAAABBBB'.endsWith(resumed)).toBe(true);
    expect(resumed).toContain('B');
  });
});

describe('PtySession — lifecycle (lazy open / ref-counted detach, NFR-AV1)', () => {
  it('detaches (kills the attach client) only when the LAST subscriber leaves', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    const subA = await session.subscribe(collector().sub);
    const subB = await session.subscribe(collector().sub);
    const pty = transport.ptys[0]!;

    subA.close();
    expect(pty.killed).toBe(false); // still one viewer → keep attached
    expect(session.isAttached).toBe(true);

    subB.close();
    expect(pty.killed).toBe(true); // last viewer gone → detach
    expect(session.isAttached).toBe(false);
  });

  it('re-opens a NEW attach PTY when a client returns after full detach', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);

    (await session.subscribe(collector().sub)).close();
    expect(transport.ptys).toHaveLength(1);

    await session.subscribe(collector().sub);
    expect(transport.ptys).toHaveLength(2); // fresh attachment
  });

  it('delivers the recorded exit to a late subscriber (mirrors PtyHandle contract)', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const live = collector();
    await session.subscribe(live.sub);
    transport.ptys[0]!.exit({ exitCode: 0, signal: null });
    expect(live.exits).toHaveLength(1);
  });

  it('resize is forwarded to the shared PTY and remembered for re-open', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);
    await session.resize(120, 40);
    expect(transport.ptys[0]!.resizes).toContainEqual({ cols: 120, rows: 40 });
  });
});

describe('PtySession — dumb-courier discipline (spec §4.3/§5.1)', () => {
  it('only opens PTYs via the transport (no node-side logic)', async () => {
    const transport = new FakeTransport();
    const openSpy = vi.spyOn(transport, 'openPty');
    const session = makeSession(transport);
    await session.subscribe(collector().sub);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PtySession — alternate-screen reattach (htop/vim garble fix)', () => {
  it('replays a CLEAN alt-buffer reset (not raw old-size frames) when a full-screen app is active', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);

    // htop enters the alternate screen and paints frames sized to the old viewport.
    transport.ptys[0]!.emit('\x1b[?1049hGARBLED_OLD_FRAME_padding_padding');
    expect(session.isAltScreen).toBe(true);

    // A reattaching client must NOT receive the garbled frames — just a clean alt
    // buffer; the program repaints itself (agentd forces a SIGWINCH on re-attach).
    const late = collector();
    await session.subscribe(late.sub);
    const replay = late.text();
    expect(replay).not.toContain('GARBLED_OLD_FRAME');
    expect(replay).toContain('\x1b[?1049h');
  });

  it('replays the scrollback ring normally when on the normal screen', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);
    transport.ptys[0]!.emit('flock@host:~$ ls\r\n');

    const late = collector();
    await session.subscribe(late.sub);
    expect(late.text()).toContain('flock@host:~$ ls');
  });

  it('clears alt state on exit so normal replay resumes', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);
    transport.ptys[0]!.emit('\x1b[?1049happ');
    expect(session.isAltScreen).toBe(true);
    transport.ptys[0]!.emit('\x1b[?1049lback to shell');
    expect(session.isAltScreen).toBe(false);
  });

  it('drops stale alt frames from the resume ring on alt-exit (quit htop), keeping post-exit output', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);
    transport.ptys[0]!.emit('\x1b[?1049h'); // enter alt (htop)
    transport.ptys[0]!.emit('GARBLED_HTOP_FRAME_padding'); // alt redraws
    transport.ptys[0]!.emit('\x1b[?1049lback at the shell$ '); // quit htop + normal output
    expect(session.isAltScreen).toBe(false);

    const late = collector();
    await session.subscribe(late.sub);
    const replay = late.text();
    expect(replay).not.toContain('GARBLED_HTOP_FRAME'); // stale alt frames dropped
    expect(replay).toContain('back at the shell$'); // post-exit output kept
  });

  it('detects an alt-enter split across two chunks', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    await session.subscribe(collector().sub);
    transport.ptys[0]!.emit('text\x1b[?10');
    transport.ptys[0]!.emit('49htui');
    expect(session.isAltScreen).toBe(true);
  });
});
