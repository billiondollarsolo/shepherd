import { describe, expect, it } from 'vitest';

import {
  PERMISSION_MODES_BY_AGENT,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_SHORT,
  permissionModesForAgent,
} from './permissionModes';

describe('permissionModesForAgent', () => {
  it('returns the supported modes for agents that expose them', () => {
    expect(permissionModesForAgent('claude-code')).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'autonomous',
    ]);
    expect(permissionModesForAgent('codex')).toEqual(PERMISSION_MODES_BY_AGENT.codex);
    // antigravity orders plan before acceptEdits.
    expect(permissionModesForAgent('antigravity')).toEqual([
      'default',
      'plan',
      'acceptEdits',
      'autonomous',
    ]);
  });

  it('returns [] for agents without a picker and for null/undefined/unknown', () => {
    expect(permissionModesForAgent('terminal')).toEqual([]);
    expect(permissionModesForAgent('opencode')).toEqual([]);
    expect(permissionModesForAgent(null)).toEqual([]);
    expect(permissionModesForAgent(undefined)).toEqual([]);
    expect(permissionModesForAgent('not-a-real-agent')).toEqual([]);
  });

  it('has a label and short label for every mode', () => {
    for (const modes of Object.values(PERMISSION_MODES_BY_AGENT)) {
      for (const mode of modes ?? []) {
        expect(PERMISSION_MODE_LABELS[mode]).toBeTruthy();
        expect(PERMISSION_MODE_SHORT[mode]).toBeTruthy();
      }
    }
  });
});
