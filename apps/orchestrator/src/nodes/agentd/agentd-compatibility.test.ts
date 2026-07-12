import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  evaluateAgentdCompatibility,
  loadAgentdCompatibilityPolicy,
  type ResolvedAgentdCompatibilityPolicy,
} from './agentd-compatibility.js';

const policy: ResolvedAgentdCompatibilityPolicy = {
  schemaVersion: 1,
  preferredDaemonVersion: '0.4.0',
  minimumDaemonVersion: '0.3.0',
  preferredProtocolVersion: 2,
  supportedProtocolVersions: [2],
  requiredCapabilities: ['pty', 'resize'],
  supportWindow: { minorReleases: 1, minimumDays: 90 },
};

const verified = {
  servicePrepared: true,
  runtimeVerified: true,
  protocolVersion: 2,
  capabilities: ['pty', 'resize', 'extra'],
} as const;

describe('agentd compatibility policy', () => {
  it('implements SemVer precedence including prereleases and build metadata', () => {
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0+one', '1.0.0+two')).toBe(0);
    expect(compareSemver('1.0', '1.0.0')).toBeNull();
  });

  it('loads and validates the checked-in release policy', () => {
    const loaded = loadAgentdCompatibilityPolicy('0.3.0', {}, process.cwd());
    expect(loaded.minimumDaemonVersion).toBe('0.3.0');
    expect(loaded.supportedProtocolVersions).toContain(loaded.preferredProtocolVersion);
  });

  it.each([
    ['', 'required', 'not-installed'],
    ['garbage', 'required', 'invalid-version'],
    ['0.2.9', 'required', 'below-minimum'],
    ['0.3.0', 'recommended', 'older-supported'],
    ['0.4.0', 'compatible', 'current'],
    ['0.5.0', 'compatible', 'newer-compatible'],
  ] as const)('classifies daemon %s as %s (%s)', (installedVersion, state, reason) => {
    expect(evaluateAgentdCompatibility(policy, { ...verified, installedVersion })).toMatchObject({
      state,
      reason,
    });
  });

  it('requires a supported authenticated protocol and all required capabilities', () => {
    expect(
      evaluateAgentdCompatibility(policy, {
        ...verified,
        installedVersion: '0.4.0',
        protocolVersion: 1,
      }),
    ).toMatchObject({ state: 'required', reason: 'unsupported-protocol' });
    expect(
      evaluateAgentdCompatibility(policy, {
        ...verified,
        installedVersion: '0.4.0',
        capabilities: ['pty'],
      }),
    ).toMatchObject({
      state: 'required',
      reason: 'missing-capabilities',
      missingCapabilities: ['resize'],
    });
  });

  it('recommends service migration but never replaces a newer compatible binary', () => {
    expect(
      evaluateAgentdCompatibility(policy, {
        ...verified,
        installedVersion: '0.5.0',
        servicePrepared: false,
      }),
    ).toMatchObject({
      state: 'recommended',
      reason: 'service-migration',
      binaryReplacement: false,
    });
  });
});
