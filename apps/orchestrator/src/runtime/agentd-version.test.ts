import { describe, expect, it } from 'vitest';
import { resolveAgentdVersion } from './agentd-version.js';

describe('resolveAgentdVersion', () => {
  it('prefers and trims an explicit version', () => {
    expect(resolveAgentdVersion({ FLOCK_AGENTD_VERSION: ' 0.3.0 ' }, '/missing')).toBe('0.3.0');
  });

  it('fails closed when no configured or shipped version exists', () => {
    expect(() => resolveAgentdVersion({}, '/definitely/missing')).toThrow(
      /Cannot resolve the agentd version/,
    );
  });
});
