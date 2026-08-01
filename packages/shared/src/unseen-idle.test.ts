import { describe, expect, it } from 'vitest';
import { nextUnseenIdle } from './unseen-idle.js';

describe('nextUnseenIdle (D9)', () => {
  it('sets true when becoming idle from running while unfocused', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'running',
        nextStatus: 'idle',
        focused: false,
        prevUnseenIdle: false,
      }),
    ).toBe(true);
  });

  it('stays true if already unseen and still idle unfocused', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'idle',
        nextStatus: 'idle',
        focused: false,
        prevUnseenIdle: true,
      }),
    ).toBe(true);
  });

  it('idle unfocused is true even without prev flag', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'idle',
        nextStatus: 'idle',
        focused: false,
        prevUnseenIdle: false,
      }),
    ).toBe(true);
  });

  it('clears when focused', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'idle',
        nextStatus: 'idle',
        focused: true,
        prevUnseenIdle: true,
      }),
    ).toBe(false);
  });

  it('clears on done / error', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'idle',
        nextStatus: 'done',
        focused: false,
        prevUnseenIdle: true,
      }),
    ).toBe(false);
    expect(
      nextUnseenIdle({
        prevStatus: 'running',
        nextStatus: 'error',
        focused: false,
        prevUnseenIdle: false,
      }),
    ).toBe(false);
  });

  it('false while running unfocused', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'running',
        nextStatus: 'running',
        focused: false,
        prevUnseenIdle: false,
      }),
    ).toBe(false);
  });

  it('clears when leaving idle for running', () => {
    expect(
      nextUnseenIdle({
        prevStatus: 'idle',
        nextStatus: 'running',
        focused: false,
        prevUnseenIdle: true,
      }),
    ).toBe(false);
  });
});
