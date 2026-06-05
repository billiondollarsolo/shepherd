import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputQuietHeuristic } from './quiet-heuristic.js';
import type { StatusSignal } from './types.js';

const QUIET_MS = 1500;

describe('OutputQuietHeuristic (US-20: output-then-quiet floor)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function make() {
    const out: StatusSignal[] = [];
    const h = new OutputQuietHeuristic({ quietMs: QUIET_MS, onSignal: (s) => out.push(s) });
    return { out, h };
  }

  it('goes idle after output stops for longer than the quiet threshold', () => {
    const { out, h } = make();
    h.onOutput(Buffer.from('working...'));
    expect(out).toEqual([]); // not yet quiet

    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(out).toEqual([]); // still under threshold

    vi.advanceTimersByTime(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'idle', reason: 'output-quiet' });
  });

  it('does not go idle while output keeps arriving (timer keeps resetting)', () => {
    const { out, h } = make();
    for (let i = 0; i < 5; i++) {
      h.onOutput(Buffer.from(`chunk ${i}`));
      vi.advanceTimersByTime(QUIET_MS - 100); // always just shy of the threshold
    }
    expect(out).toEqual([]);
  });

  it('transitions back to running when new bytes arrive after being quiet', () => {
    const { out, h } = make();
    h.onOutput(Buffer.from('first burst'));
    vi.advanceTimersByTime(QUIET_MS);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('idle');

    // New output after going quiet -> back to running.
    h.onOutput(Buffer.from('second burst'));
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ status: 'running', reason: 'output-resumed' });

    // ...and it can go idle again after another quiet period.
    vi.advanceTimersByTime(QUIET_MS);
    expect(out).toHaveLength(3);
    expect(out[2]?.status).toBe('idle');
  });

  it('does not emit a duplicate idle signal when already idle', () => {
    const { out, h } = make();
    h.onOutput(Buffer.from('x'));
    vi.advanceTimersByTime(QUIET_MS);
    expect(out).toHaveLength(1);

    // No further output; advancing more time must not re-fire idle.
    vi.advanceTimersByTime(QUIET_MS * 3);
    expect(out).toHaveLength(1);
  });

  it('does not emit "output-resumed" repeatedly while already running', () => {
    const { out, h } = make();
    h.onOutput(Buffer.from('a'));
    vi.advanceTimersByTime(100);
    h.onOutput(Buffer.from('b'));
    vi.advanceTimersByTime(100);
    h.onOutput(Buffer.from('c'));
    // Still active the whole time -> no signals emitted yet.
    expect(out).toEqual([]);
  });

  it('treats an empty buffer as no activity (does not arm the timer)', () => {
    const { out, h } = make();
    h.onOutput(Buffer.alloc(0));
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(out).toEqual([]);
  });

  it('stop() clears the pending quiet timer so no idle fires afterwards', () => {
    const { out, h } = make();
    h.onOutput(Buffer.from('x'));
    h.stop();
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(out).toEqual([]);
  });

  describe('bell-then-quiet -> done (spec §7.1)', () => {
    it('resolves to done when a bell was marked before going quiet', () => {
      const { out, h } = make();
      h.onOutput(Buffer.from('agent ringing'));
      h.markBell();
      vi.advanceTimersByTime(QUIET_MS);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ status: 'done', reason: 'bell-then-quiet' });
    });

    it('clears the bell flag so a later quiet period is plain idle', () => {
      const { out, h } = make();
      h.markBell();
      h.onOutput(Buffer.from('x'));
      vi.advanceTimersByTime(QUIET_MS); // done
      expect(out[0]?.status).toBe('done');

      h.onOutput(Buffer.from('more work')); // running
      vi.advanceTimersByTime(QUIET_MS); // idle (no bell this time)
      expect(out.map((s) => s.status)).toEqual(['done', 'running', 'idle']);
    });
  });

  it('reproduces a timed byte-sequence scenario: burst, quiet, burst, quiet', () => {
    const { out, h } = make();

    h.onOutput(Buffer.from('compiling'));
    vi.advanceTimersByTime(500);
    h.onOutput(Buffer.from('linking')); // resets timer
    vi.advanceTimersByTime(QUIET_MS); // idle
    h.onOutput(Buffer.from('rebuild triggered')); // running
    vi.advanceTimersByTime(QUIET_MS); // idle

    expect(out.map((s) => `${s.reason}:${s.status}`)).toEqual([
      'output-quiet:idle',
      'output-resumed:running',
      'output-quiet:idle',
    ]);
  });
});
