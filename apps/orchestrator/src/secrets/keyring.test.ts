import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CURRENT_KEY_VERSION,
  Keyring,
  MasterKeyError,
  decodeMasterKey,
  envVarForVersion,
  resolveKeyVersion,
} from './keyring.js';

describe('Keyring / master-key resolution (US-3, NFR-SEC2)', () => {
  it('maps version 0 to FLOCK_MASTER_KEY and version N to FLOCK_MASTER_KEY_V<N>', () => {
    expect(envVarForVersion(0)).toBe('FLOCK_MASTER_KEY');
    expect(envVarForVersion(3)).toBe('FLOCK_MASTER_KEY_V3');
  });

  it('decodes a base64 32-byte key', () => {
    const raw = randomBytes(32).toString('base64');
    const key = decodeMasterKey(raw, 'FLOCK_MASTER_KEY');
    expect(key.length).toBe(32);
  });

  it('decodes a 64-char hex key', () => {
    const raw = randomBytes(32).toString('hex');
    expect(raw).toHaveLength(64);
    const key = decodeMasterKey(raw, 'FLOCK_MASTER_KEY');
    expect(key.length).toBe(32);
  });

  it('throws a clear MasterKeyError when the key is missing', () => {
    expect(() => decodeMasterKey(undefined, 'FLOCK_MASTER_KEY')).toThrow(MasterKeyError);
    expect(() => decodeMasterKey('', 'FLOCK_MASTER_KEY')).toThrow(MasterKeyError);
  });

  it('throws MasterKeyError when the key is the wrong length', () => {
    const tooShort = randomBytes(16).toString('base64');
    expect(() => decodeMasterKey(tooShort, 'FLOCK_MASTER_KEY')).toThrow(MasterKeyError);
  });

  it('resolves and caches keys by version from the provided source', () => {
    const v0 = randomBytes(32).toString('base64');
    const v1 = randomBytes(32).toString('hex');
    const ring = new Keyring({ FLOCK_MASTER_KEY: v1, FLOCK_MASTER_KEY_V0: v0 }, 1);
    expect(ring.currentVersion).toBe(1);
    expect(ring.currentKey().equals(ring.keyForVersion(1))).toBe(true);
    expect(ring.keyForVersion(0).length).toBe(32);
    // cached: same Buffer reference on second resolution
    expect(ring.keyForVersion(0)).toBe(ring.keyForVersion(0));
  });

  it('defaults to current key version 0', () => {
    expect(CURRENT_KEY_VERSION).toBe(0);
    const ring = new Keyring({ FLOCK_MASTER_KEY: randomBytes(32).toString('hex') });
    expect(ring.currentVersion).toBe(0);
  });

  it('missing key for a requested version throws MasterKeyError', () => {
    const ring = new Keyring({ FLOCK_MASTER_KEY: randomBytes(32).toString('hex') }, 0);
    expect(() => ring.keyForVersion(5)).toThrow(MasterKeyError);
  });

  describe('resolveKeyVersion (FLOCK_MASTER_KEY_VERSION rotation wiring)', () => {
    it('defaults to CURRENT_KEY_VERSION when unset/blank', () => {
      expect(resolveKeyVersion({})).toBe(CURRENT_KEY_VERSION);
      expect(resolveKeyVersion({ FLOCK_MASTER_KEY_VERSION: '' })).toBe(CURRENT_KEY_VERSION);
    });
    it('reads an explicit integer version', () => {
      expect(resolveKeyVersion({ FLOCK_MASTER_KEY_VERSION: '2' })).toBe(2);
    });
    it('throws on a malformed version', () => {
      expect(() => resolveKeyVersion({ FLOCK_MASTER_KEY_VERSION: 'x' })).toThrow(MasterKeyError);
      expect(() => resolveKeyVersion({ FLOCK_MASTER_KEY_VERSION: '-1' })).toThrow(MasterKeyError);
    });
    it('Keyring derives currentVersion from the env so rotation actually works', () => {
      const v1 = randomBytes(32).toString('hex');
      const v0 = randomBytes(32).toString('hex');
      const ring = new Keyring({
        FLOCK_MASTER_KEY_VERSION: '1',
        FLOCK_MASTER_KEY: v1, // current (v1)
        FLOCK_MASTER_KEY_V0: v0, // previous (v0) still decryptable
      });
      expect(ring.currentVersion).toBe(1);
      expect(ring.currentKey().toString('hex')).toBe(v1);
      expect(ring.keyForVersion(0).toString('hex')).toBe(v0);
    });
  });
});
