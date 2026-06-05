import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './hashing.js';

describe('auth/hashing — argon2id (US-4/US-5, FR-A1)', () => {
  it('produces an argon2id encoded hash that is not the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('salts: two hashes of the same password differ', async () => {
    const a = await hashPassword('hunter2hunter2');
    const b = await hashPassword('hunter2hunter2');
    expect(a).not.toBe(b);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    await expect(verifyPassword(hash, 's3cret-passphrase')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    await expect(verifyPassword(hash, 'wrong-passphrase')).resolves.toBe(false);
  });

  it('returns false (never throws) for a malformed stored hash', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
  });
});
