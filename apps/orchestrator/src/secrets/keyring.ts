import { SECRET_KEY_BYTES } from '@flock/shared';

// Local fallback equal to the shared constant. The shared value remains the
// single source of truth for the contract; this guards against an undefined at
// runtime if the shared package's compiled output lags its source during a
// partial build (the value is a fixed AES-256 invariant, never independently
// tuned here).
const KEY_BYTES = SECRET_KEY_BYTES ?? 32;

/**
 * Master-key resolution for the secret store (US-3, NFR-SEC2, spec §6).
 *
 * The master key is supplied via environment / secret file — never baked into an
 * image (NFR-DEP2). To support rotation (`key_version`), the keyring resolves a
 * key per version, RELATIVE to the keyring's current version:
 *   - the current version:    `FLOCK_MASTER_KEY`
 *   - any other version N:     `FLOCK_MASTER_KEY_V<N>`
 *
 * Rotation flow: when you rotate, bump the current version (e.g. 0 → 1), put the
 * NEW key in `FLOCK_MASTER_KEY`, and move the previous key to
 * `FLOCK_MASTER_KEY_V0`. New secrets are stamped with the new version; old
 * ciphertext (key_version 0) still decrypts via `FLOCK_MASTER_KEY_V0`.
 *
 * Keys are 32-byte AES-256 keys provided as base64 or hex (64 hex chars). This
 * keeps env config human-manageable while enforcing exact key length.
 *
 * Spec §10 edge case: "Master secret key missing/rotated → clear startup error;
 * key_version allows decrypt of old ciphertext." Missing/invalid keys therefore
 * throw a clear, typed error rather than silently degrading.
 */

/** Env var holding the current master key. */
export const MASTER_KEY_ENV = 'FLOCK_MASTER_KEY';
/** The default key_version stamped on freshly encrypted secrets. */
export const CURRENT_KEY_VERSION = 0;

/** Thrown when a required master key is absent or malformed. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/**
 * Resolves the env var name for a key version, relative to `currentVersion`.
 * The current version reads `FLOCK_MASTER_KEY`; older versions read
 * `FLOCK_MASTER_KEY_V<N>`.
 */
export function envVarForVersion(
  version: number,
  currentVersion: number = CURRENT_KEY_VERSION,
): string {
  return version === currentVersion ? MASTER_KEY_ENV : `${MASTER_KEY_ENV}_V${version}`;
}

/**
 * Decode a master key string (base64 or 64-char hex) into exactly 32 raw bytes.
 * Throws {@link MasterKeyError} if the value is missing or not 32 bytes.
 */
export function decodeMasterKey(raw: string | undefined, envName: string): Buffer {
  if (!raw || raw.length === 0) {
    throw new MasterKeyError(
      `Missing master key: set ${envName} to a 32-byte AES-256 key (base64 or 64 hex chars).`,
    );
  }

  let key: Buffer | undefined;
  // Prefer hex when the string is exactly 64 hex chars; otherwise try base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === KEY_BYTES) {
      key = decoded;
    }
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new MasterKeyError(
      `Invalid master key in ${envName}: expected ${KEY_BYTES} bytes (base64 or 64 hex chars).`,
    );
  }
  return key;
}

/**
 * Resolve the CURRENT key version from `FLOCK_MASTER_KEY_VERSION` (default
 * {@link CURRENT_KEY_VERSION}). This is what makes key ROTATION work: bump the
 * version, put the new key in `FLOCK_MASTER_KEY`, and the previous key in
 * `FLOCK_MASTER_KEY_V<old>` so old secrets still decrypt. Throws on a malformed
 * value rather than silently mis-versioning.
 */
export function resolveKeyVersion(
  source: Record<string, string | undefined> = process.env,
): number {
  const raw = source.FLOCK_MASTER_KEY_VERSION;
  if (raw == null || raw.trim() === '') return CURRENT_KEY_VERSION;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new MasterKeyError(
      `FLOCK_MASTER_KEY_VERSION must be a non-negative integer; got "${raw}"`,
    );
  }
  return n;
}

/**
 * Resolves master keys by version from a key source (defaults to `process.env`).
 * Caches decoded keys for the lifetime of the keyring.
 */
export class Keyring {
  private readonly cache = new Map<number, Buffer>();

  constructor(
    private readonly source: Record<string, string | undefined> = process.env,
    public readonly currentVersion: number = resolveKeyVersion(source),
  ) {}

  /** Returns the 32-byte key for `version`, throwing if absent/invalid. */
  keyForVersion(version: number): Buffer {
    const cached = this.cache.get(version);
    if (cached) return cached;
    const envName = envVarForVersion(version, this.currentVersion);
    const key = decodeMasterKey(this.source[envName], envName);
    this.cache.set(version, key);
    return key;
  }

  /** The key used to encrypt new secrets (current version). */
  currentKey(): Buffer {
    return this.keyForVersion(this.currentVersion);
  }
}
