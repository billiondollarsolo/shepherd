import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScreencastBandwidthControlMessage } from '@flock/shared';
import { useScreencastSettings } from './useScreencastSettings';

/**
 * US-29 — web screencast settings hook (NFR-PERF3, all four user-facing controls).
 *
 * Headline criterion: a BACKGROUNDED tab stops consuming bandwidth — when the
 * page is hidden the hook emits a `blur` (which the orchestrator turns into a
 * pause/throttle), and when the tab closes it emits `stop` (on-demand).
 */

const SID = '11111111-1111-4111-8111-111111111111';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  act(() => setHidden(false));
});

describe('useScreencastSettings — control #4: on-demand', () => {
  it('emits start when the tab opens and stop when it closes', () => {
    const sent: ScreencastBandwidthControlMessage[] = [];
    const send = (m: ScreencastBandwidthControlMessage) => sent.push(m);

    const { rerender } = renderHook(
      ({ open }) => useScreencastSettings({ sessionId: SID, open, send }),
      { initialProps: { open: false } },
    );
    expect(sent).toEqual([]);

    act(() => rerender({ open: true }));
    expect(sent.at(-1)).toMatchObject({ action: 'start', sessionId: SID });

    act(() => rerender({ open: false }));
    expect(sent.at(-1)).toMatchObject({ action: 'stop', sessionId: SID });
  });
});

describe('useScreencastSettings — control #2: backgrounded stops bandwidth (NFR-PERF3)', () => {
  it('emits blur when the page is hidden and focus when shown again', () => {
    const sent: ScreencastBandwidthControlMessage[] = [];
    const send = (m: ScreencastBandwidthControlMessage) => sent.push(m);

    renderHook(() => useScreencastSettings({ sessionId: SID, open: true, send }));

    act(() => setHidden(true));
    expect(sent.at(-1)).toMatchObject({ action: 'blur', sessionId: SID });

    act(() => setHidden(false));
    expect(sent.at(-1)).toMatchObject({ action: 'focus', sessionId: SID });
  });

  it('does NOT emit focus/blur while the tab is closed (on-demand floor)', () => {
    const sent: ScreencastBandwidthControlMessage[] = [];
    const send = (m: ScreencastBandwidthControlMessage) => sent.push(m);

    renderHook(() => useScreencastSettings({ sessionId: SID, open: false, send }));
    act(() => setHidden(true));
    expect(sent.find((m) => m.action === 'blur')).toBeUndefined();
  });
});

describe('useScreencastSettings — control #3: adjustable JPEG quality', () => {
  it('clamps and emits a quality control message', () => {
    const sent: ScreencastBandwidthControlMessage[] = [];
    const send = (m: ScreencastBandwidthControlMessage) => sent.push(m);

    const { result } = renderHook(() =>
      useScreencastSettings({ sessionId: SID, open: true, send }),
    );

    act(() => result.current.setQuality(25));
    expect(result.current.quality).toBe(25);
    expect(sent.at(-1)).toMatchObject({ action: 'quality', quality: 25 });

    act(() => result.current.setQuality(9999));
    expect(result.current.quality).toBe(100);
    act(() => result.current.setQuality(-5));
    expect(result.current.quality).toBe(1);
  });
});

describe('useScreencastSettings — control #2 policy toggle', () => {
  it('switches the unfocused policy and re-applies blur if already backgrounded', () => {
    const sent: ScreencastBandwidthControlMessage[] = [];
    const send = (m: ScreencastBandwidthControlMessage) => sent.push(m);

    const { result } = renderHook(() =>
      useScreencastSettings({ sessionId: SID, open: true, send }),
    );
    act(() => setHidden(true));
    sent.length = 0;

    act(() => result.current.setUnfocusedPolicy('throttle'));
    expect(result.current.unfocusedPolicy).toBe('throttle');
    // Re-emits blur so the new policy takes effect immediately.
    expect(sent.at(-1)).toMatchObject({ action: 'blur', sessionId: SID });
  });
});
