import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EncryptedSecret, SECRET_AUTH_TAG_BYTES, SECRET_NONCE_BYTES } from '@flock/shared';
import type { AuditLogger } from '../audit/audit.js';
import { CURRENT_KEY_VERSION, Keyring } from './keyring.js';

/**
 * App-level encryption at rest for secrets (US-3, FR-A4, NFR-SEC2, spec §6).
 *
 * Algorithm: AES-256-GCM (authenticated encryption) via node:crypto.
 *   - 96-bit random nonce per encryption (never reused with the same key).
 *   - 128-bit auth tag stored alongside ciphertext; verified on decrypt so any
 *     tampering OR wrong-key use fails closed (GCM auth failure).
 *   - `key_version` stamped on every envelope to allow master-key rotation:
 *     old ciphertext stays decryptable as long as that version's key is present.
 *
 * The store NEVER persists plaintext (FR-A4). On decrypt it writes a
 * `secret_access` audit row (FR-A3) through the injected {@link AuditLogger}.
 */

/** Thrown when decryption fails (wrong key, tampered ciphertext, bad version). */
export class SecretDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretDecryptError';
  }
}

/** Context recorded with the `secret_access` audit row written on decrypt. */
export interface DecryptContext {
  /** The secret's id (audit target). */
  secretId: string;
  /** Acting user, if any. */
  userId?: string | null;
  /** Source IP, if the access came over the network. */
  ip?: string | null;
}

export interface SecretStoreOptions {
  /** Key source; defaults to a {@link Keyring} over process.env. */
  keyring?: Keyring;
  /** Audit sink for `secret_access` rows. Optional but recommended in prod. */
  audit?: AuditLogger;
}

export class SecretStore {
  private readonly keyring: Keyring;
  private readonly audit?: AuditLogger;

  constructor(options: SecretStoreOptions = {}) {
    this.keyring = options.keyring ?? new Keyring();
    this.audit = options.audit;
  }

  /**
   * Validate the master key at BOOT (call before listening). Throws
   * {@link MasterKeyError} (via the keyring) on a missing/malformed key, so a
   * misconfig fails loud at startup instead of as an opaque 500 on the first
   * encrypt (e.g. creating an SSH node) much later.
   */
  assertReady(): void {
    this.keyring.currentKey();
  }

  /**
   * Encrypts UTF-8 plaintext (or raw bytes) with the current master key.
   * Returns the at-rest envelope; the caller persists ciphertext/nonce/authTag/
   * keyVersion to the `secrets` table. Plaintext is never returned or stored.
   */
  encrypt(plaintext: string | Uint8Array): EncryptedSecret {
    const keyVersion = this.keyring.currentVersion;
    const key = this.keyring.currentKey();
    const nonce = randomBytes(SECRET_NONCE_BYTES);

    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const data =
      typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce: new Uint8Array(nonce),
      authTag: new Uint8Array(authTag),
      keyVersion,
    };
  }

  /**
   * Decrypts an envelope using the key for its `keyVersion`. On success writes a
   * `secret_access` audit row (when an audit logger is configured) and returns
   * the plaintext bytes. On any failure (wrong key, tampered ciphertext) throws
   * {@link SecretDecryptError} and writes NO audit row (access did not succeed).
   */
  async decrypt(secret: EncryptedSecret, ctx: DecryptContext): Promise<Buffer> {
    const parsed = EncryptedSecret.parse(secret);
    if (parsed.authTag.byteLength !== SECRET_AUTH_TAG_BYTES) {
      throw new SecretDecryptError(
        `Invalid auth tag length: expected ${SECRET_AUTH_TAG_BYTES} bytes.`,
      );
    }

    let key: Buffer;
    try {
      key = this.keyring.keyForVersion(parsed.keyVersion);
    } catch (cause) {
      throw new SecretDecryptError(
        `No master key available for key_version ${parsed.keyVersion}.`,
        { cause },
      );
    }

    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.nonce));
      decipher.setAuthTag(Buffer.from(parsed.authTag));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext)),
        decipher.final(),
      ]);
    } catch (cause) {
      // GCM auth failure: wrong key or tampered ciphertext. Fail closed; no audit.
      throw new SecretDecryptError('Secret decryption failed: wrong key or corrupted ciphertext.', {
        cause,
      });
    }

    // Successful access → append-only audit row (FR-A3).
    if (this.audit) {
      await this.audit.recordSecretAccess({
        secretId: ctx.secretId,
        userId: ctx.userId ?? null,
        ip: ctx.ip ?? null,
        keyVersion: parsed.keyVersion,
      });
    }

    return plaintext;
  }

  /** Decrypts and returns the secret as a UTF-8 string. */
  async decryptToString(secret: EncryptedSecret, ctx: DecryptContext): Promise<string> {
    return (await this.decrypt(secret, ctx)).toString('utf8');
  }
}

export { CURRENT_KEY_VERSION };
