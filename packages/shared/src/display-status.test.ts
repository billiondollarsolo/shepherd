import { describe, expect, it } from 'vitest';
import {
  displayStatus,
  isWorkingDisplayStatus,
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

  it('working filter only includes running and starting agents', () => {
    expect(isWorkingDisplayStatus('running')).toBe(true);
    expect(isWorkingDisplayStatus('starting')).toBe(true);
    expect(isWorkingDisplayStatus('awaiting_input')).toBe(false);
    expect(isWorkingDisplayStatus('done')).toBe(false);
    expect(isWorkingDisplayStatus('error')).toBe(false);
    expect(isWorkingDisplayStatus('idle')).toBe(false);
    expect(isWorkingDisplayStatus('disconnected')).toBe(false);
  });
});
