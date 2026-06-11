/**
 * Auth + user-management routes (US-4/US-5/US-6, spec §8.1, FR-A1/A2/A3).
 *
 *   POST /api/auth/setup   first-run admin; 409 once an admin exists      [US-4]
 *   POST /api/auth/login   validate creds, set httpOnly+Secure cookie     [US-5]
 *   POST /api/auth/logout  revoke the sessions_auth row, clear cookie     [US-5]
 *   GET  /api/auth/me      current user (401 without a valid cookie)      [US-5]
 *   POST /api/users        admin-only invite/create (403 for member)      [US-6]
 *   GET  /api/users        admin-only list                               [US-6]
 *
 * Bodies are validated with the shared zod contracts from `@flock/shared`
 * (never duplicated). The login cookie is httpOnly + Secure + SameSite=Strict
 * (NFR-SEC1/SEC6). All auth surfaces are off the live status path, so
 * synchronous DB use through {@link AuthService} is correct.
 */
import type { FastifyInstance } from 'fastify';
import {
  CreateUserRequest,
  LoginRequest,
  SetupRequest,
  UpdateProfileRequest,
} from '@flock/shared';
import { buildClearSessionCookie, buildSessionCookie, readSessionCookie } from './cookie.js';
import { buildGuards } from './middleware.js';
import { LoginThrottle } from './login-throttle.js';
import {
  AdminAlreadyExistsError,
  InvalidCredentialsError,
  SESSION_TTL_MS,
  UsernameTakenError,
  type AuthService,
  type RequestContext,
} from './service.js';
import { badRequest } from '../http/reply.js';

function ctxOf(request: { ip?: string; headers: Record<string, unknown> }): RequestContext {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
}

/**
 * Register the auth + users routes against an {@link AuthService}. Exposed as a
 * plain function (not an auto-loaded plugin) so `buildServer` wires it with the
 * concrete service and so tests can register it on an isolated Fastify app.
 */
export function registerAuthRoutes(app: FastifyInstance, service: AuthService): void {
  const { requireAuth, requireAdmin } = buildGuards(service);
  // In-memory brute-force throttle for the public credential endpoints (T6).
  const throttle = new LoginThrottle();

  // --- US-4: first-run admin setup ---------------------------------------
  app.post('/api/auth/setup', async (request, reply) => {
    const parsed = SetupRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, 'username and a password (min 8 chars) are required.');
    }
    try {
      const user = await service.setupInitialAdmin(parsed.data, ctxOf(request));
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof AdminAlreadyExistsError) {
        return reply
          .code(409)
          .send({ error: { code: 'admin_exists', message: err.message } });
      }
      if (err instanceof UsernameTakenError) {
        return reply
          .code(409)
          .send({ error: { code: 'username_taken', message: err.message } });
      }
      throw err;
    }
  });

  // --- first-run status (public) -----------------------------------------
  // Lets the sign-in UI decide between "create first admin" and "sign in"
  // without a destructive probe. Public: callable before any session exists.
  app.get('/api/auth/status', async (_request, reply) => {
    const setupRequired = !(await service.adminExists());
    return reply.code(200).send({ setupRequired });
  });

  // --- US-5: login -------------------------------------------------------
  app.post('/api/auth/login', async (request, reply) => {
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
        error: { code: 'too_many_attempts', message: 'Too many login attempts. Try again later.' },
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
  });

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
      return reply.code(404).send({ error: { code: 'user_not_found', message: 'User was not found.' } });
    }
    return reply.code(200).send({ user });
  });

  // --- change own password (self-serve) ----------------------------------
  app.post(
    '/api/auth/change-password',
    { preHandler: requireAuth },
    async (request, reply) => {
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
          return reply
            .code(401)
            .send({ error: { code: 'invalid_credentials', message: 'Current password is incorrect.' } });
        }
        throw err;
      }
    },
  );

  // --- US-6: invite/create a user (admin) --------------------------------
  app.post('/api/users', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = CreateUserRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(
        reply,
        'username, a password (min 8 chars), and a role (admin|member) are required.',
      );
    }
    try {
      const user = await service.createUser(
        parsed.data,
        { id: request.authUser!.id },
        ctxOf(request),
      );
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        return reply
          .code(409)
          .send({ error: { code: 'username_taken', message: err.message } });
      }
      throw err;
    }
  });

  // --- US-6: list users (admin) ------------------------------------------
  app.get('/api/users', { preHandler: requireAdmin }, async (_request, reply) => {
    const users = await service.listUsers();
    return reply.code(200).send({ users });
  });
}
