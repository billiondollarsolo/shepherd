import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@flock/shared';
import { SESSION_COOKIE } from './cookie.js';
import { makeRequireAdmin, makeRequireAuth, type AuthGuardDeps } from './middleware.js';

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

const adminUser: User = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  role: 'admin',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
const memberUser: User = {
  ...adminUser,
  id: '22222222-2222-4222-8222-222222222222',
  username: 'bob',
  role: 'member',
};

function depsReturning(user: User | null): AuthGuardDeps {
  return { getUserBySession: vi.fn().mockResolvedValue(user) };
}

describe('requireAuth (US-5, NFR-SEC6)', () => {
  it('401 when no cookie is present (and the session lookup is short-circuited)', async () => {
    const reply = makeReply();
    const lookup = vi.fn().mockResolvedValue(adminUser);
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
    await makeRequireAuth(depsReturning(adminUser))(req, reply);
    expect(reply.statusCode).toBe(0); // never sent an error
    expect(req.authUser).toEqual(adminUser);
  });
});

describe('requireAdmin (US-5/US-6, FR-A2)', () => {
  it('401 when unauthenticated', async () => {
    const reply = makeReply();
    await makeRequireAdmin(depsReturning(null))(makeRequest(`${SESSION_COOKIE}=x`), reply);
    expect(reply.statusCode).toBe(401);
  });

  it('403 when an authenticated member hits an admin-only route', async () => {
    const reply = makeReply();
    const req = makeRequest(`${SESSION_COOKIE}=good`);
    await makeRequireAdmin(depsReturning(memberUser))(req, reply);
    expect(reply.statusCode).toBe(403);
    expect(reply.body?.error?.code).toBe('forbidden');
  });

  it('passes for an authenticated admin', async () => {
    const reply = makeReply();
    const req = makeRequest(`${SESSION_COOKIE}=good`);
    await makeRequireAdmin(depsReturning(adminUser))(req, reply);
    expect(reply.statusCode).toBe(0);
    expect(req.authUser).toEqual(adminUser);
  });
});
