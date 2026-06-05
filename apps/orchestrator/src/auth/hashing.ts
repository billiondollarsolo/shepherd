/**
 * Password hashing (US-4/US-5, FR-A1).
 *
 * argon2id — the memory-hard, side-channel-resistant Argon2 variant recommended
 * for password storage (OWASP). The orchestrator NEVER stores plaintext
 * passwords; only the argon2id encoded hash (which embeds its own salt +
 * parameters) is persisted to `users.password_hash` and it is never serialized
 * to clients.
 *
 * `verifyPassword` is failure-tolerant: a malformed/garbage stored hash returns
 * `false` rather than throwing, so a corrupted row can never crash the login
 * path or leak which branch failed.
 */
import argon2 from 'argon2';

/**
 * Tuned argon2id parameters. These exceed argon2's defaults for memoryCost
 * while staying responsive for an interactive login on a modest VPS.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB (OWASP minimum for argon2id)
  timeCost: 2,
  parallelism: 1,
};

/** Hash a plaintext password with argon2id. Returns the encoded hash string. */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored argon2id hash. Returns `false`
 * (never throws) on mismatch OR on a malformed stored hash.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
