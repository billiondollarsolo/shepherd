import { readFileSync } from 'node:fs';

/** Minimum entropy-bearing bootstrap-token length accepted at startup. */
export const MIN_SETUP_TOKEN_LENGTH = 32;

/**
 * Load the one-time installation bootstrap token from a Docker/Kubernetes secret
 * file. Production refuses to start without it, closing the fresh-install race
 * where the first internet client could otherwise claim the owner account.
 *
 * Development remains frictionless unless a file is explicitly configured.
 */
export function readSetupToken(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const path = env.FLOCK_SETUP_TOKEN_FILE?.trim();
  if (!path) {
    if (env.NODE_ENV === 'production') {
      throw new Error('FLOCK_SETUP_TOKEN_FILE is required when NODE_ENV=production');
    }
    return undefined;
  }

  let token: string;
  try {
    token = readFile(path).trim();
  } catch (error) {
    throw new Error(`could not read FLOCK_SETUP_TOKEN_FILE: ${(error as Error).message}`);
  }
  if (token.length < MIN_SETUP_TOKEN_LENGTH) {
    throw new Error(
      `FLOCK_SETUP_TOKEN_FILE must contain at least ${MIN_SETUP_TOKEN_LENGTH} characters`,
    );
  }
  return token;
}
