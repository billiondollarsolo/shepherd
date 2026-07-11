import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScreencastBandwidthControlMessage } from '@flock/shared';
import { ScreencastSettings } from './ScreencastSettings';

/**
 * US-29 — Screencast bandwidth controls settings panel smoke (NFR-PERF3).
 * Renders the quality slider + unfocused policy toggle and asserts they drive
 * the shared control channel.
 */

const SID = '22222222-2222-4222-8222-222222222222';

describe('ScreencastSettings (US-29)', () => {
  it('renders the quality slider and unfocused policy options', () => {
    render(<ScreencastSettings sessionId={SID} open={true} send={() => {}} />);
    expect(screen.getByLabelText('JPEG quality')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /throttle/i })).toBeTruthy();
  });

  it('emits a quality control message when the slider moves (#3)', () => {
    const sent: ScreencastBandwidthControlMessage[] = [];
    render(<ScreencastSettings sessionId={SID} open={true} send={(m) => sent.push(m)} />);
    fireEvent.change(screen.getByLabelText('JPEG quality'), {
      target: { value: '30' },
    });
    expect(sent.at(-1)).toMatchObject({ action: 'quality', quality: 30 });
  });

  it('switches the unfocused policy to throttle (#2)', () => {
    render(<ScreencastSettings sessionId={SID} open={true} send={() => {}} />);
    const throttle = screen.getByRole('radio', {
      name: /throttle/i,
    }) as HTMLInputElement;
    fireEvent.click(throttle);
    expect(throttle.checked).toBe(true);
  });
});
