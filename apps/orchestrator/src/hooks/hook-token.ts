/**
 * Hook-token hashing. The per-session hook token is 256 bits of CSPRNG
 * (`randomBytes(32)`), so it already has full entropy — argon2id's memory-hardness
 * buys nothing and is far too expensive for the DB-free hook HOT PATH (every agent
 * event verifies it). A plain SHA-256 one-way store + constant-time compare is the
 * correct, fast primitive here. (argon2id stays for PASSWORDS, which are low-entropy.)
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** One-way hash to persist in `agent_sessions.hook_token_hash`. */
export function hashHookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time verify of a presented token against the stored hash. */
export function verifyHookToken(hash: string, token: string): boolean {
  const expected = hashHookToken(token);
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}
