/**
 * US-11 — PtySessionRegistry unit tests (run under `pnpm test:unit`).
 *
 * The registry is the FR-S6 enabler: two clients subscribing to the SAME
 * sessionId must share ONE PtySession (one tmux attach, one resume buffer), and
 * the shared session is created on first use. On last-detach the session LINGERS
 * for a window (so a quick reconnect resumes from its buffer) then drops. It also
 * upholds the single-authoritative-record discipline (spec §4.2): one id → one
 * live attachment.
 */
import { describe, expect, it } from 'vitest';

import type {
  ExecOptions,
  ExecResult,
  NodeTransport,
  OpenPtyOptions,
  PtyHandle,
} from '../../nodes/transport/transport.js';
import { PtySessionRegistry } from './pty-session-registry.js';

class FakePtyHandle implements PtyHandle {
  private readonly dataListeners = new Set<(c: string) => void>();
  killed = false;
  onData(l: (c: string) => void): () => void {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }
  onExit(): () => void {
    return () => {};
  }
  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
  emit(chunk: string): void {
    for (const l of [...this.dataListeners]) l(chunk);
  }
}

class FakeTransport implements NodeTransport {
  readonly kind = 'local' as const;
  readonly ptys: FakePtyHandle[] = [];
  async exec(_c: string[], _o?: ExecOptions): Promise<ExecResult> {
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  }
  async openPty(_o?: OpenPtyOptions): Promise<PtyHandle> {
    const p = new FakePtyHandle();
    this.ptys.push(p);
    return p;
  }
  async dispose(): Promise<void> {}
}

const ID = '22222222-2222-4222-8222-222222222222';

function sub(): { onData(c: Buffer): void; chunks: Buffer[]; text(): string } {
  const chunks: Buffer[] = [];
  return {
    chunks,
    onData: (c: Buffer) => chunks.push(c),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

describe('PtySessionRegistry (US-11, FR-S6)', () => {
  it('shares ONE PtySession across two subscribers of the same id', async () => {
    const transport = new FakeTransport();
    const registry = new PtySessionRegistry({
      resolve: () => ({ transport, attachCommand: () => ['tmux', 'attach'], workingDir: '/w' }),
    });

    const a = sub();
    const b = sub();
    await registry.subscribe(ID, a);
    await registry.subscribe(ID, b);

    expect(registry.size).toBe(1);
    expect(transport.ptys).toHaveLength(1); // one shared attach for both

    transport.ptys[0]!.emit('shared\n');
    expect(a.text()).toBe('shared\n');
    expect(b.text()).toBe('shared\n');
    registry.closeAll();
  });

  it('releases the tmux attachment when the last subscriber detaches', async () => {
    const transport = new FakeTransport();
    const registry = new PtySessionRegistry({
      lingerMs: 0, // drop immediately so we can assert the released state
      resolve: () => ({ transport, attachCommand: () => ['tmux', 'attach'] }),
    });

    const s1 = await registry.subscribe(ID, sub());
    const s2 = await registry.subscribe(ID, sub());
    expect(registry.size).toBe(1);

    s1.close();
    expect(registry.size).toBe(1); // one viewer remains
    s2.close();
    // With zero linger the session is dropped and its attachment killed.
    expect(registry.size).toBe(0);
    expect(transport.ptys[0]!.killed).toBe(true);
  });

  it('LINGERS after the last detach so a reconnect resumes from the buffer', async () => {
    const transport = new FakeTransport();
    const registry = new PtySessionRegistry({
      lingerMs: 60_000, // generous window; we reconnect immediately
      resumeBufferBytes: 64 * 1024,
      resolve: () => ({ transport, attachCommand: () => ['tmux', 'attach'] }),
    });

    const first = sub();
    const s = await registry.subscribe(ID, first);
    transport.ptys[0]!.emit('was-here\n');
    s.close(); // last subscriber leaves → linger, buffer retained

    expect(registry.size).toBe(1); // still tracked during the linger window

    const reconnect = sub();
    await registry.subscribe(ID, reconnect);
    // The reconnecting client resumes from the lingered buffer.
    expect(reconnect.text()).toContain('was-here\n');
    registry.closeAll();
  });

  it('resolves the binding only once per live session', async () => {
    const transport = new FakeTransport();
    let resolveCalls = 0;
    const registry = new PtySessionRegistry({
      resolve: () => {
        resolveCalls += 1;
        return { transport, attachCommand: () => ['tmux', 'attach'] };
      },
    });
    await registry.subscribe(ID, sub());
    await registry.subscribe(ID, sub());
    expect(resolveCalls).toBe(1);
    registry.closeAll();
  });

  it('closeAll closes every tracked attachment', async () => {
    const transport = new FakeTransport();
    const registry = new PtySessionRegistry({
      resolve: () => ({ transport, attachCommand: () => ['tmux', 'attach'] }),
    });
    await registry.subscribe(ID, sub());
    await registry.subscribe('33333333-3333-4333-8333-333333333333', sub());
    expect(registry.size).toBe(2);
    registry.closeAll();
    expect(registry.size).toBe(0);
    for (const p of transport.ptys) expect(p.killed).toBe(true);
  });
});
