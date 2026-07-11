/**
 * Single-owner authentication routes (spec §8.1, FR-A1/A2/A3).
 *
 *   POST /api/auth/setup   first-run installation owner                   [US-4]
 *   POST /api/auth/login   validate creds, set httpOnly+Secure cookie     [US-5]
 *   POST /api/auth/logout  revoke the sessions_auth row, clear cookie     [US-5]
 *   GET  /api/auth/me      current user (401 without a valid cookie)      [US-5]
 *
 * Bodies are validated with the shared zod contracts from `@flock/shared`
 * (never duplicated). The login cookie is httpOnly + Secure + SameSite=Strict
 * (NFR-SEC1/SEC6). All auth surfaces are off the live status path, so
 * synchronous DB use through {@link AuthService} is correct.
 */
import type { FastifyInstance } from 'fastify';
import { LoginRequest, SetupRequest, UpdateProfileRequest } from '@flock/shared';
import { buildClearSessionCookie, buildSessionCookie, readSessionCookie } from './cookie.js';
import { makeRequireAuth } from './middleware.js';
import { LoginThrottle } from './login-throttle.js';
import {
  OwnerAlreadyExistsError,
  InvalidCredentialsError,
  SESSION_TTL_MS,
  UsernameTakenError,
  type AuthService,
  type RequestContext,
} from './service.js';
import { badRequest } from '../http/reply.js';
import {
  RequestBudget,
  makeRejectionReporter,
  withinRequestBudget,
} from '../http/request-budget.js';

const AUTH_BODY_LIMIT = 16 * 1024;

function ctxOf(request: { ip?: string; headers: Record<string, unknown> }): RequestContext {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
}

/**
 * Register the owner-auth routes against an {@link AuthService}. Exposed as a
 * plain function (not an auto-loaded plugin) so `buildServer` wires it with the
 * concrete service and so tests can register it on an isolated Fastify app.
 */
export function registerAuthRoutes(app: FastifyInstance, service: AuthService): void {
  const requireAuth = makeRequireAuth(service);
  // In-memory brute-force throttle for the public credential endpoints (T6).
  const throttle = new LoginThrottle();
  const setupBudget = new RequestBudget({
    maxRequests: 10,
    windowMs: 60 * 60_000,
    maxConcurrent: 4,
    maxConcurrentPerKey: 1,
    onReject: makeRejectionReporter('auth-setup'),
  });
  const loginBudget = new RequestBudget({
    maxRequests: 60,
    windowMs: 60_000,
    maxConcurrent: 16,
    maxConcurrentPerKey: 4,
    onReject: makeRejectionReporter('auth-login'),
  });

  // --- US-4: first-run owner setup ---------------------------------------
  app.post('/api/auth/setup', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) =>
    withinRequestBudget(reply, setupBudget, request.ip, async () => {
      const parsed = SetupRequest.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'username and a password (min 8 chars) are required.');
      }
      try {
        const user = await service.setupInitialOwner(parsed.data, ctxOf(request));
        return reply.code(201).send({ user });
      } catch (err) {
        if (err instanceof OwnerAlreadyExistsError) {
          return reply.code(409).send({ error: { code: 'owner_exists', message: err.message } });
        }
        if (err instanceof UsernameTakenError) {
          return reply.code(409).send({ error: { code: 'username_taken', message: err.message } });
        }
        throw err;
      }
    }),
  );

  // --- first-run status (public) -----------------------------------------
  // Lets the sign-in UI decide between "create owner" and "sign in"
  // without a destructive probe. Public: callable before any session exists.
  app.get('/api/auth/status', async (_request, reply) => {
    const setupRequired = !(await service.ownerExists());
    return reply.code(200).send({ setupRequired });
  });

  // --- US-5: login -------------------------------------------------------
  app.post('/api/auth/login', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) =>
    withinRequestBudget(reply, loginBudget, request.ip, async () => {
      const parsed = LoginRequest.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'username and password are required.');
      }
      // Brute-force throttle (T6): cap guesses per ip+username; locks after repeated
      // failures, clears on success. Checked BEFORE the (expensive) argon2 verify.
      const tkey = LoginThrottle.key(request.ip, parsed.data.username);
      const gate = throttle.check(tkey);
      if (!gate.allowed) {
        void reply.header('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
        return reply.code(429).send({
          error: {
            code: 'too_many_requests',
            message: 'Too many login attempts. Try again later.',
          },
        });
      }
      try {
        const { sessionId, user } = await service.login(parsed.data, ctxOf(request));
        throttle.recordSuccess(tkey);
        void reply.header('set-cookie', buildSessionCookie(sessionId, SESSION_TTL_MS));
        return reply.code(200).send({ user });
      } catch (err) {
        if (err instanceof InvalidCredentialsError) {
          throttle.recordFailure(tkey);
          return reply
            .code(401)
            .send({ error: { code: 'invalid_credentials', message: err.message } });
        }
        throw err;
      }
    }),
  );

  // --- US-5: logout ------------------------------------------------------
  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId) {
      await service.logout(sessionId, ctxOf(request));
    }
    void reply.header('set-cookie', buildClearSessionCookie());
    return reply.code(204).send();
  });

  // --- US-5: current user ------------------------------------------------
  app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    // requireAuth guarantees authUser is set (else it already replied 401).
    return reply.code(200).send({ user: request.authUser });
  });

  // --- update own profile (display name) ---------------------------------
  app.patch('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = UpdateProfileRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, 'a valid displayName (string or null) is required.');
    }
    const user = await service.updateProfile(request.authUser!.id, parsed.data);
    if (!user) {
      return reply
        .code(404)
        .send({ error: { code: 'user_not_found', message: 'User was not found.' } });
    }
    return reply.code(200).send({ user });
  });

  // --- change own password (self-serve) ----------------------------------
  app.post('/api/auth/change-password', { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || newPassword.length < 8) {
      return badRequest(reply, 'currentPassword and a newPassword (min 8 chars) are required.');
    }
    try {
      await service.changePassword(
        request.authUser!.id,
        { currentPassword, newPassword },
        ctxOf(request),
      );
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return reply.code(401).send({
          error: { code: 'invalid_credentials', message: 'Current password is incorrect.' },
        });
      }
      throw err;
    }
  });
}
