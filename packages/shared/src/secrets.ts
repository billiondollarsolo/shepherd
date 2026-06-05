import { z } from 'zod';

/**
 * Shared contracts for the encrypted secret store (US-3 / FR-A4, NFR-SEC2).
 *
 * A secret is persisted as ciphertext only — never plaintext. The envelope below
 * mirrors the `secrets` Postgres table from spec §6:
 *   secrets: id, kind, ciphertext (bytea), nonce, key_version, created_at
 *
 * `key_version` enables master-key rotation: old ciphertext stays decryptable as
 * long as the orchestrator still holds the key for that version (spec §10 edge
 * case: "Master secret key missing/rotated → key_version allows decrypt of old
 * ciphertext"). AES-256-GCM produces a 16-byte authentication tag that is stored
 * alongside the ciphertext so tampering / wrong-key use fails closed on decrypt.
 *
 * The secret-kind enum lives in `domain.ts` as `SecretKindEnum`/`SecretKind` and
 * is NOT redefined here (single source of truth).
 */

/**
 * The cryptographic envelope produced by {@link encrypt} and consumed by
 * {@link decrypt}. This is the canonical at-rest shape; the DB row stores these
 * fields (plus id/kind/created_at).
 *
 * Buffers are validated structurally as `Uint8Array` so the schema is usable on
 * both the orchestrator (Node Buffer) and any future client without coupling to
 * Node's Buffer type.
 */
export const EncryptedSecret = z.object({
  /** AES-256-GCM ciphertext (does NOT include the auth tag). */
  ciphertext: z.instanceof(Uint8Array),
  /** 12-byte GCM nonce / IV; unique per encryption. */
  nonce: z.instanceof(Uint8Array),
  /** 16-byte GCM authentication tag. */
  authTag: z.instanceof(Uint8Array),
  /** Which master-key version encrypted this; drives rotation. */
  keyVersion: z.number().int().nonnegative(),
});
export type EncryptedSecret = z.infer<typeof EncryptedSecret>;

/** GCM nonce length in bytes (96-bit nonce is the GCM-recommended size). */
export const SECRET_NONCE_BYTES = 12;
/** AES-256 key length in bytes. */
export const SECRET_KEY_BYTES = 32;
/** GCM authentication tag length in bytes. */
export const SECRET_AUTH_TAG_BYTES = 16;
