import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@flock/shared';
import { SESSION_COOKIE } from './cookie.js';
import { makeRequireAuth, type AuthGuardDeps } from './middleware.js';

interface CapturedError {
  error?: { code?: string; message?: string };
}

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as CapturedError | undefined,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    send(b: unknown) {
      this.body = b as CapturedError;
      return this;
    },
  };
  return reply as unknown as FastifyReply & {
    statusCode: number;
    body: CapturedError | undefined;
  };
}

function makeRequest(cookie?: string): FastifyRequest {
  return {
    headers: cookie ? { cookie } : {},
  } as unknown as FastifyRequest;
}

const ownerUser: User = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'owner',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
function depsReturning(user: User | null): AuthGuardDeps {
  return { getUserBySession: vi.fn().mockResolvedValue(user) };
}

describe('requireAuth (US-5, NFR-SEC6)', () => {
  it('401 when no cookie is present (and the session lookup is short-circuited)', async () => {
    const reply = makeReply();
    const lookup = vi.fn().mockResolvedValue(ownerUser);
    await makeRequireAuth({ getUserBySession: lookup })(makeRequest(), reply);
    expect(reply.statusCode).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('401 when the session cookie is invalid/expired (service returns null)', async () => {
    const reply = makeReply();
    const deps = depsReturning(null);
    await makeRequireAuth(deps)(makeRequest(`${SESSION_COOKIE}=deadbeef`), reply);
    expect(reply.statusCode).toBe(401);
    expect(deps.getUserBySession).toHaveBeenCalledWith('deadbeef');
  });

  it('passes and attaches authUser for a valid session', async () => {
    const reply = makeReply();
    const req = makeRequest(`${SESSION_COOKIE}=good`);
    await makeRequireAuth(depsReturning(ownerUser))(req, reply);
    expect(reply.statusCode).toBe(0); // never sent an error
    expect(req.authUser).toEqual(ownerUser);
  });
});
