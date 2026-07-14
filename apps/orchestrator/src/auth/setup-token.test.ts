import { describe, expect, it } from 'vitest';
import { MIN_SETUP_TOKEN_LENGTH, readSetupToken } from './setup-token.js';

describe('readSetupToken', () => {
  it('requires a file-backed token in production', () => {
    expect(() => readSetupToken({ NODE_ENV: 'production' })).toThrow(/required/);
  });

  it('loads and trims a sufficiently long token', () => {
    const token = 'x'.repeat(MIN_SETUP_TOKEN_LENGTH);
    expect(
      readSetupToken(
        { NODE_ENV: 'production', FLOCK_SETUP_TOKEN_FILE: '/run/secrets/setup' },
        () => `  ${token}\n`,
      ),
    ).toBe(token);
  });

  it('rejects missing and weak token files', () => {
    expect(() =>
      readSetupToken({ NODE_ENV: 'production', FLOCK_SETUP_TOKEN_FILE: '/missing' }, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/could not read/);
    expect(() =>
      readSetupToken(
        { NODE_ENV: 'production', FLOCK_SETUP_TOKEN_FILE: '/run/secrets/setup' },
        () => 'too-short',
      ),
    ).toThrow(/at least 32/);
  });

  it('is optional in development unless explicitly configured', () => {
    expect(readSetupToken({ NODE_ENV: 'development' })).toBeUndefined();
  });
});
