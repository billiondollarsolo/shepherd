/**
 * US-22 — the Web Push trigger predicate (spec §7 table, FR-ST4).
 *
 * The headline acceptance criterion: transitions to `awaiting_input` / `done` /
 * `error` send a push; OTHER transitions do not. These tests pin that contract
 * EXHAUSTIVELY over every value of the shared StatusEnum, so adding a new status
 * without deciding its push policy fails CI rather than silently defaulting.
 */
import { STATUS_VALUES, type Status } from '@flock/shared';
import { describe, expect, it } from 'vitest';

import { shouldSendPush } from './should-notify.js';

/** The exact set of push-worthy statuses per the spec §7 table (FR-ST4). */
const PUSH_STATES: ReadonlySet<Status> = new Set<Status>(['awaiting_input', 'done', 'error']);

describe('shouldSendPush (US-22 trigger predicate, FR-ST4)', () => {
  it('returns true for awaiting_input, done, and error', () => {
    expect(shouldSendPush('awaiting_input')).toBe(true);
    expect(shouldSendPush('done')).toBe(true);
    expect(shouldSendPush('error')).toBe(true);
  });

  it('returns false for starting, running, idle, and disconnected', () => {
    expect(shouldSendPush('starting')).toBe(false);
    expect(shouldSendPush('running')).toBe(false);
    expect(shouldSendPush('idle')).toBe(false);
    expect(shouldSendPush('disconnected')).toBe(false);
  });

  it('is exhaustive: EVERY StatusEnum value maps to the spec §7 push policy', () => {
    // If a new status is added to the shared enum, this assertion forces an
    // explicit decision here (it will fail until PUSH_STATES is updated).
    for (const status of STATUS_VALUES) {
      expect(shouldSendPush(status)).toBe(PUSH_STATES.has(status));
    }
  });

  it('pushes on EXACTLY three of the seven statuses (no over/under-firing)', () => {
    const pushCount = STATUS_VALUES.filter((s) => shouldSendPush(s)).length;
    expect(pushCount).toBe(3);
  });
});
