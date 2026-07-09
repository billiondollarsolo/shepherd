import { describe, expect, it } from 'vitest';
import {
  displayStatus,
  isActiveDisplayStatus,
  loudStatusWord,
  statusWord,
} from './display-status.js';
import type { Status } from './status.js';

describe('display-status calm map', () => {
  it('maps awaiting_input to loud Needs you', () => {
    const d = displayStatus('awaiting_input');
    expect(d.kind).toBe('blocked');
    expect(d.loud).toBe(true);
    expect(statusWord('awaiting_input')).toBe('Needs you');
    expect(loudStatusWord('awaiting_input')).toBe('Needs you');
  });

  it('idle is affirmative Idle (not blank) but not loud attention', () => {
    expect(displayStatus('idle').loud).toBe(false);
    expect(statusWord('idle')).toBe('Idle');
    expect(loudStatusWord('idle')).toBeNull();
  });

  it('working/error/done/disconnected are loud', () => {
    const loud: Status[] = ['running', 'starting', 'error', 'done', 'disconnected'];
    for (const s of loud) {
      expect(displayStatus(s).loud).toBe(true);
      expect(statusWord(s).length).toBeGreaterThan(0);
    }
    expect(statusWord('running')).toBe('Working');
  });

  it('active filter includes working blocked done error', () => {
    expect(isActiveDisplayStatus('awaiting_input')).toBe(true);
    expect(isActiveDisplayStatus('running')).toBe(true);
    expect(isActiveDisplayStatus('done')).toBe(true);
    expect(isActiveDisplayStatus('error')).toBe(true);
    expect(isActiveDisplayStatus('idle')).toBe(false);
    expect(isActiveDisplayStatus('disconnected')).toBe(false);
  });
});
