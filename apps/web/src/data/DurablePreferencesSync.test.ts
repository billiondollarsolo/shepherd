import { describe, expect, it } from 'vitest';
import type { UserPreferencesValueV1 } from '@flock/shared';
import { mergePreferences } from './DurablePreferencesSync';

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

function preferences(overrides: Partial<UserPreferencesValueV1> = {}): UserPreferencesValueV1 {
  return { version: 1, nodeOrder: [], sessionOrder: {}, layoutPresets: [], ...overrides };
}

describe('mergePreferences', () => {
  it('keeps locally edited fields and accepts remote changes to untouched fields', () => {
    const base = preferences({ nodeOrder: [NODE_A] });
    const local = preferences({ nodeOrder: [NODE_B] });
    const remote = preferences({
      nodeOrder: [NODE_A],
      sessionOrder: { [PROJECT]: [SESSION] },
    });

    expect(mergePreferences(base, local, remote)).toEqual({
      version: 1,
      nodeOrder: [NODE_B],
      sessionOrder: { [PROJECT]: [SESSION] },
      layoutPresets: [],
    });
  });

  it('takes the remote value when the local field is unchanged', () => {
    const base = preferences({ nodeOrder: [NODE_A] });
    const remote = preferences({ nodeOrder: [NODE_B] });
    expect(mergePreferences(base, base, remote).nodeOrder).toEqual([NODE_B]);
  });
});
