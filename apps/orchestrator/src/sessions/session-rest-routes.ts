/**
 * Session list/create routes (spec §8.1, FR-S2/FR-S3, NFR-SEC6).
 *
 *   GET  /api/sessions[?projectId=...]   { sessions: Session[] }
 *   POST /api/sessions                   body CreateSessionRequest → 201
 *                                        CreateSessionResponse { session }
 *
 * Cookie-authed via the shared `requireAuth` guard. Query/body validated with the
 * shared zod contracts (`ListSessionsQuery`, `CreateSessionRequest`); an unknown
 * project on create maps to 404. The success body is the shared
 * `CreateSessionResponse`. Agent-only hook capability material stays inside the
 * orchestrator and is never serialized to the browser.
 *
 * NOTE: this registers ONLY `GET`/`POST /api/sessions`. `DELETE /api/sessions/:id`
 * (terminate, US-13) is owned by `registerTerminateSessionRoute`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateSessionRequest,
  ListSessionsQuery,
  SessionIdParams,
  toPublicSession,
  UpdateSessionRequest,
} from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { SessionProjectNotFoundError, type SessionRestService } from './session-rest-service.js';

/**
 * Register `GET`/`POST /api/sessions` against a {@link SessionRestService}. Plain
 * function so `buildServer` wires it with the concrete service + auth guard.
 */
export function registerSessionRestRoutes(
  app: FastifyInstance,
  deps: { service: SessionRestService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  // --- list sessions -----------------------------------------------------
  app.get(
    '/api/sessions',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListSessionsQuery.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(reply, 'projectId, when provided, must be a valid id.');
      }
      const sessions = await deps.service.listSessions(parsed.data.projectId);
      return reply.code(200).send({ sessions: sessions.map(toPublicSession) });
    },
  );

  // --- create session ----------------------------------------------------
  app.post(
    '/api/sessions',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateSessionRequest.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'projectId and agentType are required.');
      }
      // requireAuth guarantees authUser is set (else it already replied 401).
      const actor = request.authUser!;
      try {
        const result = await deps.service.createSession(parsed.data, {
          userId: actor.id,
          ip: request.ip ?? null,
        });
        return reply.code(201).send({ session: toPublicSession(result.session) });
      } catch (err) {
        if (err instanceof SessionProjectNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: 'project_not_found', message: err.message } });
        }
        throw err;
      }
    },
  );

  // --- update session metadata (pin / note) ------------------------------
  app.patch(
    '/api/sessions/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = SessionIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid session id is required.');
      const body = UpdateSessionRequest.safeParse(request.body);
      if (!body.success)
        return badRequest(reply, 'provide pinned, note, and/or reviewed to update.');
      const session = await deps.service.updateSession(params.data.id, body.data, {
        userId: request.authUser?.id ?? null,
      });
      if (!session) {
        return reply
          .code(404)
          .send({ error: { code: 'session_not_found', message: 'Session not found.' } });
      }
      return reply.code(200).send({ session: toPublicSession(session) });
    },
  );
}
