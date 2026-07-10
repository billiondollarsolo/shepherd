import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EncryptedSecret,
  SECRET_AUTH_TAG_BYTES,
  SECRET_NONCE_BYTES,
} from '@flock/shared';
import { AuditEntry, AuditLogger, AuditSink } from '../audit/audit.js';
import { Keyring } from './keyring.js';
import { SecretDecryptError, SecretStore } from './secret-store.js';

/** In-memory audit sink that records every row for assertions. */
class FakeAuditSink implements AuditSink {
  rows: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.rows.push(entry);
  }
}

/** Build a 32-byte key as a base64 string, like an env-provided master key. */
function makeKeyB64(): string {
  return randomBytes(32).toString('base64');
}

function storeWithKeys(
  env: Record<string, string | undefined>,
  audit?: AuditLogger,
  currentVersion = 0,
): SecretStore {
  return new SecretStore({
    keyring: new Keyring(env, currentVersion),
    audit,
  });
}

describe('SecretStore (US-3 — encryption at rest, AES-256-GCM)', () => {
  it('round-trips: decrypt(encrypt(x)) === x', async () => {
    const env = { FLOCK_MASTER_KEY: makeKeyB64() };
    const store = storeWithKeys(env);
    const plaintext = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-bytes\n';

    const envelope = store.encrypt(plaintext);
    const recovered = await store.decryptToString(envelope, { secretId: 's1' });

    expect(recovered).toBe(plaintext);
  });

  it('round-trips raw binary plaintext', async () => {
    const env = { FLOCK_MASTER_KEY: makeKeyB64() };
    const store = storeWithKeys(env);
    const bytes = randomBytes(64);

    const envelope = store.encrypt(bytes);
    const recovered = await store.decrypt(envelope, { secretId: 's-bin' });

    expect(Buffer.compare(recovered, bytes)).toBe(0);
  });

  it('produces a valid envelope: 12-byte nonce, 16-byte auth tag, ciphertext != plaintext', () => {
    const env = { FLOCK_MASTER_KEY: makeKeyB64() };
    const store = storeWithKeys(env);
    const plaintext = 'hook-token-abc123';

    const envelope = store.encrypt(plaintext);

    // Envelope conforms to the shared zod contract.
    expect(() => EncryptedSecret.parse(envelope)).not.toThrow();
    expect(envelope.nonce.byteLength).toBe(SECRET_NONCE_BYTES);
    expect(envelope.authTag.byteLength).toBe(SECRET_AUTH_TAG_BYTES);
    // Ciphertext must not contain the plaintext (FR-A4: no plaintext at rest).
    const ctText = Buffer.from(envelope.ciphertext).toString('utf8');
    expect(ctText).not.toContain(plaintext);
    expect(Buffer.from(envelope.ciphertext).toString('hex')).not.toContain(
      Buffer.from(plaintext, 'utf8').toString('hex'),
    );
  });

  it('uses a fresh nonce per encryption (same plaintext → different ciphertext)', () => {
    const env = { FLOCK_MASTER_KEY: makeKeyB64() };
    const store = storeWithKeys(env);

    const a = store.encrypt('same');
    const b = store.encrypt('same');

    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('stamps the current key_version on encrypt', () => {
    const env = { FLOCK_MASTER_KEY: makeKeyB64() };
    const store = storeWithKeys(env, undefined, 0);
    expect(store.encrypt('x').keyVersion).toBe(0);
  });

  describe('wrong-key failure', () => {
    it('decrypt with a different master key throws SecretDecryptError', async () => {
      const encStore = storeWithKeys({ FLOCK_MASTER_KEY: makeKeyB64() });
      const envelope = encStore.encrypt('top-secret');

      const wrongStore = storeWithKeys({ FLOCK_MASTER_KEY: makeKeyB64() });

      await expect(
        wrongStore.decrypt(envelope, { secretId: 's1' }),
      ).rejects.toBeInstanceOf(SecretDecryptError);
    });

    it('tampered ciphertext fails authentication', async () => {
      const env = { FLOCK_MASTER_KEY: makeKeyB64() };
      const store = storeWithKeys(env);
      const envelope = store.encrypt('integrity-matters');

      const tampered: EncryptedSecret = {
        ...envelope,
        ciphertext: Uint8Array.from(envelope.ciphertext),
      };
      tampered.ciphertext[0] ^= 0xff; // flip a bit

      await expect(
        store.decrypt(tampered, { secretId: 's1' }),
      ).rejects.toBeInstanceOf(SecretDecryptError);
    });

    it('tampered auth tag fails authentication', async () => {
      const env = { FLOCK_MASTER_KEY: makeKeyB64() };
      const store = storeWithKeys(env);
      const envelope = store.encrypt('integrity-matters');

      const tampered: EncryptedSecret = {
        ...envelope,
        authTag: Uint8Array.from(envelope.authTag),
      };
      tampered.authTag[0] ^= 0xff;

      await expect(
        store.decrypt(tampered, { secretId: 's1' }),
      ).rejects.toBeInstanceOf(SecretDecryptError);
    });
  });

  describe('key_version handling (rotation)', () => {
    it('decrypts old ciphertext using the versioned key after rotation', async () => {
      const oldKey = makeKeyB64();
      const newKey = makeKeyB64();

      // v0 store encrypts with the original key.
      const v0Store = storeWithKeys({ FLOCK_MASTER_KEY: oldKey }, undefined, 0);
      const oldEnvelope = v0Store.encrypt('rotate-me');
      expect(oldEnvelope.keyVersion).toBe(0);

      // After rotation: current key is v1, old key kept under FLOCK_MASTER_KEY_V0.
      const rotatedEnv = {
        FLOCK_MASTER_KEY: newKey, // version 1 maps to FLOCK_MASTER_KEY here
        FLOCK_MASTER_KEY_V0: oldKey,
      };
      const rotatedStore = storeWithKeys(rotatedEnv, undefined, 1);

      // New secrets get v1.
      expect(rotatedStore.encrypt('fresh').keyVersion).toBe(1);
      // Old v0 secret is still decryptable via FLOCK_MASTER_KEY_V0.
      const recovered = await rotatedStore.decryptToString(oldEnvelope, {
        secretId: 's-old',
      });
      expect(recovered).toBe('rotate-me');
    });

    it('throws SecretDecryptError when no key exists for the envelope version', async () => {
      const env = { FLOCK_MASTER_KEY: makeKeyB64() }; // only v0 present
      const store = storeWithKeys(env, undefined, 0);
      const envelope = store.encrypt('x');

      const orphan: EncryptedSecret = { ...envelope, keyVersion: 7 };
      await expect(
        store.decrypt(orphan, { secretId: 's1' }),
      ).rejects.toBeInstanceOf(SecretDecryptError);
    });
  });

  describe('secret_access audit row on decrypt (FR-A3)', () => {
    it('writes exactly one secret_access row on successful decrypt', async () => {
      const sink = new FakeAuditSink();
      const env = { FLOCK_MASTER_KEY: makeKeyB64() };
      const store = storeWithKeys(env, new AuditLogger(sink));
      const envelope = store.encrypt('ssh-key');

      await store.decrypt(envelope, {
        secretId: 'secret-42',
        userId: 'user-1',
        ip: '10.0.0.5',
      });

      expect(sink.rows).toHaveLength(1);
      const row = sink.rows[0];
      expect(row.action).toBe('secret_access');
      expect(row.targetType).toBe('secret');
      expect(row.targetId).toBe('secret-42');
      expect(row.userId).toBe('user-1');
      expect(row.ip).toBe('10.0.0.5');
      expect(row.detail).toMatchObject({ keyVersion: 0 });
    });

    it('does NOT write an audit row when decrypt fails (access did not succeed)', async () => {
      const sink = new FakeAuditSink();
      const goodStore = storeWithKeys({ FLOCK_MASTER_KEY: makeKeyB64() });
      const envelope = goodStore.encrypt('x');

      const wrongStore = storeWithKeys(
        { FLOCK_MASTER_KEY: makeKeyB64() },
        new AuditLogger(sink),
      );

      await expect(
        wrongStore.decrypt(envelope, { secretId: 's1' }),
      ).rejects.toBeInstanceOf(SecretDecryptError);
      expect(sink.rows).toHaveLength(0);
    });

    it('encrypt writes no audit row (only access/decrypt is audited)', async () => {
      const sink = new FakeAuditSink();
      const store = storeWithKeys(
        { FLOCK_MASTER_KEY: makeKeyB64() },
        new AuditLogger(sink),
      );
      store.encrypt('x');
      expect(sink.rows).toHaveLength(0);
    });
  });
});
