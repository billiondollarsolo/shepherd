/**
 * Session terminate route (US-13, spec §8.1, FR-S5).
 *
 *   DELETE /api/sessions/:id   kill tmux + browser harness, mark the record
 *                              closed, write a `session_terminate` audit row.
 *
 * Authed via the session cookie (NFR-SEC6): the `requireAuth` preHandler rejects
 * an unauthenticated caller with 401 and otherwise attaches `request.authUser`,
 * which we attribute the audit row to. The path param is validated with the
 * shared `SessionIdParams` zod contract (never duplicated). An unknown session
 * maps to 404 (spec §10); the success body is the shared
 * `TerminateSessionResponse`.
 *
 * All termination logic lives in {@link TerminateSessionService}; this module is
 * framework-thin (parse → call → map result/error to HTTP), mirroring the auth
 * routes convention.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SessionIdParams } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import {
  SessionNotFoundError,
  type TerminateContext,
  type TerminateResult,
} from './terminate-session-service.js';

/**
 * The structural surface the route depends on: just `terminate`. The concrete
 * {@link TerminateSessionService} satisfies it, as does a thin wrapper that adds
 * live-channel cleanup after termination (see index.ts). Keeping it structural
 * lets the wiring decorate terminate without subclassing.
 */
export interface TerminateService {
  terminate(sessionId: string, ctx: TerminateContext): Promise<TerminateResult>;
}

/**
 * Register `DELETE /api/sessions/:id`. Exposed as a plain function (not an
 * auto-loaded plugin) so `buildServer` wires it with the concrete service +
 * auth guard, and so tests can register it on an isolated Fastify app.
 */
export function registerTerminateSessionRoute(
  app: FastifyInstance,
  deps: { service: TerminateService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.delete(
    '/api/sessions/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParams.safeParse(request.params);
      if (!parsed.success) {
        return badRequest(reply, 'a valid session id is required.');
      }

      // requireAuth guarantees authUser is set (else it already replied 401).
      const actor = request.authUser!;
      try {
        const result = await deps.service.terminate(parsed.data.id, {
          userId: actor.id,
          ip: request.ip ?? null,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: 'session_not_found', message: err.message } });
        }
        throw err;
      }
    },
  );
}
