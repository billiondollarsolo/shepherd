/**
 * Audit log read route (US-40, spec §8.1, FR-A3).
 *
 *   GET /api/audit   owner-authenticated append-only audit rows (newest-first).
 *
 * The installation owner can read them. The route is guarded by authentication:
 * an unauthenticated caller gets 401 and the owner gets the shared response. The query is validated with
 * the shared `ListAuditQuery` zod contract (never duplicated); a malformed query
 * is rejected with 400.
 *
 * All listing/normalization logic lives in {@link AuditQueryService}; this module
 * is framework-thin (parse → call → map), mirroring the auth/terminate routes.
 * The audit read is a durable-store read, NEVER the live status path (spec §6.6).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ListAuditQuery } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import type { AuditQueryService } from './audit-query-service.js';

/**
 * Register `GET /api/audit`. Exposed as a plain function (not an auto-loaded
 * plugin) so `buildServer` wires it with the concrete service + auth guard, and
 * so tests can register it on an isolated Fastify app.
 */
export function registerAuditRoutes(
  app: FastifyInstance,
  deps: { service: AuditQueryService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/audit',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListAuditQuery.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(reply, 'invalid audit query.');
      }
      // The single-owner model guarantees the authenticated user owns the installation.
      const result = await deps.service.list(parsed.data);
      return reply.code(200).send(result);
    },
  );
}
