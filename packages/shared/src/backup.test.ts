import { describe, expect, it } from 'vitest';
import { FlockVaultManifestSchema } from './backup';

const valid = {
  formatVersion: 1,
  flockVersion: '0.3.0',
  createdAt: '2026-07-11T00:00:00.000Z',
  migrationCount: 21,
  database: { format: 'pg-custom', bytes: 10, sha256: 'a'.repeat(64), recordCounts: {} },
  masterKey: { currentVersion: 0, fingerprint: `sha256:${'b'.repeat(32)}`, requiredVersions: [0] },
  included: ['PostgreSQL'],
  excluded: ['live PTY processes'],
  liveSessionSemantics: 'metadata-only-processes-reconciled',
  deployment: {
    mode: 'docker-compose',
    declaredDurableVolumes: [{ name: 'pgdata', disposition: 'captured' }],
  },
};

describe('FlockVaultManifestSchema', () => {
  it('accepts the current strict format', () => {
    expect(FlockVaultManifestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unsupported versions and malformed checksums', () => {
    expect(() => FlockVaultManifestSchema.parse({ ...valid, formatVersion: 2 })).toThrow();
    expect(() =>
      FlockVaultManifestSchema.parse({
        ...valid,
        database: { ...valid.database, sha256: '../unsafe' },
      }),
    ).toThrow();
  });
});
