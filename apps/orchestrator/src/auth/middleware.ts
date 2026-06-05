/**
 * Auth middleware (US-5, FR-A1/A2, NFR-SEC6).
 *
 * Fastify preHandlers:
 *   - `requireAuth`  — rejects a missing/invalid/expired/revoked session cookie
 *                      with 401; on success attaches the acting `User` to the
 *                      request as `request.authUser`.
 *   - `requireAdmin` — runs `requireAuth` then rejects a non-admin with 403.
 *
 * The guards are pure factories over an {@link AuthService}, so they unit-test
 * with a fake service and no HTTP server. They are framework-thin: all identity
 * logic lives in the service.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@flock/shared';
import type { AuthService } from './service.js';
import { readSessionCookie } from './cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated user, set by `requireAuth`. */
    authUser?: User;
  }
}

/** Shape of the dependency the guards need — easy to fake in unit tests. */
export interface AuthGuardDeps {
  getUserBySession(sessionId: string): Promise<User | null>;
}

function unauthorized(reply: FastifyReply): void {
  void reply.code(401).send({
    error: { code: 'unauthorized', message: 'Authentication required.' },
  });
}

function forbidden(reply: FastifyReply): void {
  void reply.code(403).send({
    error: { code: 'forbidden', message: 'Admin role required.' },
  });
}

/**
 * Resolve and attach the acting user, or reply 401. Returns the user on
 * success and `undefined` once it has already sent the 401 (caller must stop).
 */
async function authenticate(
  deps: AuthGuardDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<User | undefined> {
  const sessionId = readSessionCookie(request.headers.cookie);
  if (!sessionId) {
    unauthorized(reply);
    return undefined;
  }
  const user = await deps.getUserBySession(sessionId);
  if (!user) {
    unauthorized(reply);
    return undefined;
  }
  request.authUser = user;
  return user;
}

/** Build a `requireAuth` preHandler bound to an {@link AuthService}. */
export function makeRequireAuth(deps: AuthGuardDeps) {
  return async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await authenticate(deps, request, reply);
  };
}

/** Build a `requireAdmin` preHandler bound to an {@link AuthService}. */
export function makeRequireAdmin(deps: AuthGuardDeps) {
  return async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = await authenticate(deps, request, reply);
    if (!user) return; // 401 already sent
    if (user.role !== 'admin') {
      forbidden(reply);
    }
  };
}

/** Convenience: both guards bound to a concrete service. */
export function buildGuards(service: AuthService) {
  return {
    requireAuth: makeRequireAuth(service),
    requireAdmin: makeRequireAdmin(service),
  };
}
