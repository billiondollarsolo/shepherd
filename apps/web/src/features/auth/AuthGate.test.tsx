/**
 * AuthGate session probe: only real 401s mean logout; transient failures retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../routes/api';
import { resolveAuthSession } from './AuthGate';
import type { User } from '@flock/shared';

const user: User = {
  id: 'u1',
  username: 'admin',
  displayName: null,
  createdAt: new Date().toISOString(),
  lastLoginAt: null,
  isActive: true,
};

describe('resolveAuthSession', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns authed when /me succeeds', async () => {
    const meFn = vi.fn(async () => ({ user }));
    await expect(resolveAuthSession({ meFn, attempts: 3 })).resolves.toEqual({
      kind: 'authed',
      user,
    });
    expect(meFn).toHaveBeenCalledTimes(1);
  });

  it('returns unauthed on 401 without retrying forever', async () => {
    const meFn = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized', 'nope');
    });
    await expect(resolveAuthSession({ meFn, attempts: 5 })).resolves.toEqual({
      kind: 'unauthed',
    });
    expect(meFn).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors then recovers', async () => {
    const meFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(502, 'bad_gateway', 'down'))
      .mockResolvedValueOnce({ user });
    await expect(resolveAuthSession({ meFn, attempts: 5 })).resolves.toEqual({
      kind: 'authed',
      user,
    });
    expect(meFn).toHaveBeenCalledTimes(3);
  });

  it('returns unreachable after exhausting transient failures (not unauthed)', async () => {
    const meFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(resolveAuthSession({ meFn, attempts: 3 })).resolves.toEqual({
      kind: 'unreachable',
    });
    expect(meFn).toHaveBeenCalledTimes(3);
  });
});
