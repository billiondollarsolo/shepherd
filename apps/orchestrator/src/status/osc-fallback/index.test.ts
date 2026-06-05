import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OscFallbackStatusSource } from './index.js';
import type { StatusSignal } from './types.js';

const BEL = '\x07';
const ESC = '\x1b';
const QUIET_MS = 1000;

describe('OscFallbackStatusSource (US-20: OSC/BEL + quiet floor wired together)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function make() {
    const out: StatusSignal[] = [];
    const src = new OscFallbackStatusSource({
      quietMs: QUIET_MS,
      onSignal: (s) => out.push(s),
    });
    return { out, src };
  }

  it('OSC 9 in the stream yields awaiting_input, then done after quiet (bell-then-quiet)', () => {
    const { out, src } = make();
    src.push(Buffer.from(`${ESC}]9;needs input${BEL}`, 'utf8'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'awaiting_input', reason: 'osc9-notify' });

    // The OSC sequence ended in a BEL, so a following quiet resolves to done.
    vi.advanceTimersByTime(QUIET_MS);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ status: 'done', reason: 'bell-then-quiet' });
  });

  it('plain output then quiet yields a single idle signal', () => {
    const { out, src } = make();
    src.push(Buffer.from('just some logs without any escape codes', 'utf8'));
    expect(out).toEqual([]);
    vi.advanceTimersByTime(QUIET_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'idle', reason: 'output-quiet' });
  });

  it('output after quiet transitions back to running', () => {
    const { out, src } = make();
    src.push(Buffer.from('a', 'utf8'));
    vi.advanceTimersByTime(QUIET_MS);
    src.push(Buffer.from('b', 'utf8'));
    expect(out.map((s) => s.status)).toEqual(['idle', 'running']);
  });

  it('a standalone BEL then quiet resolves to done', () => {
    const { out, src } = make();
    src.push(Buffer.from(`output${BEL}`, 'utf8'));
    expect(out[0]).toMatchObject({ status: 'awaiting_input', reason: 'bel' });
    vi.advanceTimersByTime(QUIET_MS);
    expect(out.at(-1)).toMatchObject({ status: 'done', reason: 'bell-then-quiet' });
  });

  it('forwards every byte to both the parser and the heuristic', () => {
    const { out, src } = make();
    src.push(Buffer.from(`${ESC}]9;one${BEL}${ESC}]9;two${BEL}`, 'utf8'));
    expect(out.filter((s) => s.reason === 'osc9-notify')).toHaveLength(2);
    vi.advanceTimersByTime(QUIET_MS);
    expect(out.at(-1)?.status).toBe('done'); // ended in a bell
  });

  it('OSC 133 ; D maps to done', () => {
    const { out, src } = make();
    src.push(Buffer.from(`${ESC}]133;D${BEL}`, 'utf8'));
    expect(out.some((s) => s.status === 'done' && s.reason === 'osc133-finished')).toBe(true);
  });

  it('stop() halts the heuristic timer', () => {
    const { out, src } = make();
    src.push(Buffer.from('x', 'utf8'));
    src.stop();
    vi.advanceTimersByTime(QUIET_MS * 3);
    expect(out).toEqual([]);
  });
});
