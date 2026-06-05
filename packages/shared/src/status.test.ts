import { describe, expect, it } from 'vitest';
import {
  LIVE_STATES,
  STATUS_POLICY,
  STATUS_VALUES,
  StatusEnum,
  canTransition,
  compareByAttention,
  ringsSidebar,
  shouldNotify,
  statusPolicy,
  transition,
  type Status,
} from './status.js';

describe('StatusEnum', () => {
  it('contains exactly the seven spec §7 statuses', () => {
    expect([...STATUS_VALUES]).toEqual([
      'starting',
      'running',
      'awaiting_input',
      'idle',
      'done',
      'error',
      'disconnected',
    ]);
  });

  it('parses valid values and rejects invalid ones', () => {
    expect(StatusEnum.parse('awaiting_input')).toBe('awaiting_input');
    expect(StatusEnum.safeParse('bogus').success).toBe(false);
  });

  it('has a policy entry for every status', () => {
    for (const s of STATUS_VALUES) {
      expect(STATUS_POLICY[s]).toBeDefined();
    }
  });
});

describe('shouldNotify (Web Push policy, spec §7 table / FR-ST4)', () => {
  it('pushes only on awaiting_input, done, error', () => {
    const pushing = STATUS_VALUES.filter((s) => shouldNotify(s));
    expect(pushing.sort()).toEqual(['awaiting_input', 'done', 'error'].sort());
  });

  it.each(['starting', 'running', 'idle', 'disconnected'] as Status[])(
    'does not push on %s',
    (s) => {
      expect(shouldNotify(s)).toBe(false);
    },
  );
});

describe('ringsSidebar (spec §7 table)', () => {
  it('rings only on awaiting_input and error', () => {
    const ringing = STATUS_VALUES.filter((s) => ringsSidebar(s));
    expect(ringing.sort()).toEqual(['awaiting_input', 'error'].sort());
  });
});

describe('compareByAttention (FR-ST6, FR-UI3)', () => {
  it('sorts awaiting_input and error to the top', () => {
    const sorted = [
      'running',
      'idle',
      'error',
      'awaiting_input',
      'done',
      'starting',
      'disconnected',
    ].sort(compareByAttention as (a: string, b: string) => number) as Status[];
    expect(sorted[0]).toBe('awaiting_input');
    expect(sorted[1]).toBe('error');
  });

  it('statusPolicy returns the same object used by the helpers', () => {
    expect(statusPolicy('awaiting_input')).toBe(STATUS_POLICY.awaiting_input);
  });
});

describe('canTransition / transition', () => {
  it('allows self-transitions (idempotent re-assertion)', () => {
    for (const s of STATUS_VALUES) {
      expect(canTransition(s, s)).toBe(true);
    }
  });

  it('allows disconnected from any state', () => {
    for (const s of STATUS_VALUES) {
      expect(canTransition(s, 'disconnected')).toBe(true);
    }
  });

  it('allows reconcile from disconnected back to any state (spec §7.2)', () => {
    for (const s of STATUS_VALUES) {
      expect(canTransition('disconnected', s)).toBe(true);
    }
  });

  it('moves freely between live states plus done/error', () => {
    for (const from of LIVE_STATES) {
      for (const to of LIVE_STATES) {
        expect(canTransition(from, to)).toBe(true);
      }
      expect(canTransition(from, 'done')).toBe(true);
      expect(canTransition(from, 'error')).toBe(true);
    }
  });

  it('treats done/error as terminal except for disconnected', () => {
    for (const terminal of ['done', 'error'] as Status[]) {
      for (const to of ['starting', 'running', 'awaiting_input', 'idle'] as Status[]) {
        expect(canTransition(terminal, to)).toBe(false);
      }
      expect(canTransition(terminal, 'disconnected')).toBe(true);
    }
    // done<->error directly is also rejected (must reconcile via disconnected).
    expect(canTransition('done', 'error')).toBe(false);
    expect(canTransition('error', 'done')).toBe(false);
  });

  it('transition() returns the target on a legal move', () => {
    expect(transition('starting', 'running')).toBe('running');
  });

  it('transition() throws on an illegal move', () => {
    expect(() => transition('done', 'running')).toThrowError(/Illegal status transition/);
  });
});
