/**
 * Session events + plan routes (US-21/US-34):
 *   GET /api/sessions/:id/events  — the Activity timeline's data source
 *   GET /api/sessions/:id/plan    — the latest agent plan/todo (Plan artifact)
 * Cookie-authed (NFR-SEC6); framework-thin (parse → call → send), mirroring
 * diff-route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SessionIdParams } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import type { EventReadService } from './event-read-service.js';

export function registerEventRoute(
  app: FastifyInstance,
  deps: { service: EventReadService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/sessions/:id/events',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParams.safeParse(request.params);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'a valid session id is required.' } });
      }
      const events = await deps.service.listForSession(parsed.data.id);
      return reply.code(200).send({ events });
    },
  );

  // The whole fleet's recent activity in one chronological stream (US-1d) — the
  // cross-agent audit timeline. Top-level path so it never collides with
  // `/api/sessions/:id/*`. `?limit=` is clamped server-side (1..200).
  app.get(
    '/api/activity/fleet',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const raw = (request.query as { limit?: string } | undefined)?.limit;
      const limit = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
      const events = await deps.service.recentFleetActivity(limit);
      return reply.code(200).send({ events });
    },
  );

  // The whole fleet's latest chat message in one query — powers the Paddock cards
  // (triage what every agent is saying/asking without opening each). Top-level path
  // so it never collides with `/api/sessions/:id/*`.
  app.get(
    '/api/chats/latest',
    { preHandler: requireAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const chats = await deps.service.latestChats();
      return reply.code(200).send({ chats });
    },
  );

  app.get(
    '/api/sessions/:id/plan',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParams.safeParse(request.params);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'a valid session id is required.' } });
      }
      const plan = await deps.service.getLatestPlan(parsed.data.id);
      return reply.code(200).send({ plan });
    },
  );
}
