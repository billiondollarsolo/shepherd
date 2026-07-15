import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './SearchPanel';

describe('debounce (SearchPanel live search)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires only once after the quiet period, with the latest args', () => {
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d('a');
    d('ab');
    d('abc');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('abc');
  });

  it('resets the timer on each call (keystrokes keep it quiet)', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('x');
    vi.advanceTimersByTime(80);
    d('xy');
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('xy');
  });

  it('cancel() prevents a pending call from firing', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('q');
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});
