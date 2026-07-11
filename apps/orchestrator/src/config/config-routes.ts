/**
 * Config-as-code routes (cookie-authed):
 *   POST /api/config/apply   { yaml }  → { projectsCreated, sessionsCreated, warnings }
 *   GET  /api/config/export            → { yaml }
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ConfigError, type ConfigService } from './config-service.js';
import { makeRequireAuth, type AuthGuardDeps } from '../auth/middleware.js';

export function registerConfigRoutes(
  app: FastifyInstance,
  svc: ConfigService,
  authDeps: AuthGuardDeps,
): void {
  const requireAuth = makeRequireAuth(authDeps);

  app.post(
    '/api/config/apply',
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as { yaml?: string };
      if (typeof body.yaml !== 'string' || body.yaml.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'yaml is required' } });
      }
      try {
        const actor = req.authUser!;
        const summary = await svc.apply(body.yaml, { userId: actor.id, ip: req.ip ?? null });
        return reply.code(200).send(summary);
      } catch (e) {
        if (e instanceof ConfigError) {
          return reply.code(400).send({ error: { code: 'bad_request', message: e.message } });
        }
        return reply
          .code(500)
          .send({ error: { code: 'internal', message: 'config apply failed' } });
      }
    },
  );

  app.get(
    '/api/config/export',
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({ yaml: await svc.export() });
    },
  );
}
