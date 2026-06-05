/**
 * Audit log read route (US-40, spec §8.1, FR-A3).
 *
 *   GET /api/audit   admin-only list of append-only audit rows (newest-first).
 *
 * "Admin can read them" (US-40). The route is guarded by `requireAdmin`: an
 * unauthenticated caller gets 401, an authenticated non-admin gets 403, and an
 * admin gets 200 + the shared `ListAuditResponse`. The query is validated with
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
import { makeRequireAdmin } from '../auth/middleware.js';
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
  const requireAdmin = makeRequireAdmin(deps.auth);

  app.get(
    '/api/audit',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListAuditQuery.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(reply, 'invalid audit query.');
      }
      // requireAdmin guarantees an authenticated admin reached here.
      const result = await deps.service.list(parsed.data);
      return reply.code(200).send(result);
    },
  );
}
