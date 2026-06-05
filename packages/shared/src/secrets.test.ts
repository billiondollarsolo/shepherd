import { describe, expect, it } from 'vitest';
import {
  EncryptedSecret,
  SECRET_AUTH_TAG_BYTES,
  SECRET_KEY_BYTES,
  SECRET_NONCE_BYTES,
} from './secrets.js';
// SecretKindEnum is the single source of truth, defined in domain.ts.
import { SecretKindEnum } from './domain.js';

describe('shared secrets contracts (US-3)', () => {
  it('exposes the expected GCM/key byte sizes', () => {
    expect(SECRET_NONCE_BYTES).toBe(12);
    expect(SECRET_KEY_BYTES).toBe(32);
    expect(SECRET_AUTH_TAG_BYTES).toBe(16);
  });

  it('accepts a well-formed encrypted-secret envelope', () => {
    const envelope = {
      ciphertext: new Uint8Array([1, 2, 3]),
      nonce: new Uint8Array(SECRET_NONCE_BYTES),
      authTag: new Uint8Array(SECRET_AUTH_TAG_BYTES),
      keyVersion: 0,
    };
    expect(() => EncryptedSecret.parse(envelope)).not.toThrow();
  });

  it('rejects an envelope missing the auth tag', () => {
    const bad = {
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(SECRET_NONCE_BYTES),
      keyVersion: 0,
    };
    expect(() => EncryptedSecret.parse(bad)).toThrow();
  });

  it('rejects a negative / non-integer key version', () => {
    const base = {
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(SECRET_NONCE_BYTES),
      authTag: new Uint8Array(SECRET_AUTH_TAG_BYTES),
    };
    expect(() => EncryptedSecret.parse({ ...base, keyVersion: -1 })).toThrow();
    expect(() => EncryptedSecret.parse({ ...base, keyVersion: 1.5 })).toThrow();
  });

  it('validates secret kinds (from domain SecretKindEnum)', () => {
    expect(SecretKindEnum.parse('ssh_key')).toBe('ssh_key');
    expect(SecretKindEnum.parse('hook_token')).toBe('hook_token');
    expect(() => SecretKindEnum.parse('nope')).toThrow();
  });
});
