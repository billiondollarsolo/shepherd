/** Built-in launcher presets and durable project Pen APIs. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProjectPensV1Schema, BUILTIN_LAUNCHER_PRESETS, type ProjectPensV1 } from '@flock/shared';
import { badRequest } from '../http/reply.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';

export interface MeRouteDeps {
  auth: AuthGuardDeps;
  getPens?: (userId: string, projectId: string) => Promise<ProjectPensV1 | null>;
  putPens?: (userId: string, projectId: string, pens: ProjectPensV1) => Promise<void>;
}

export function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/me/launcher-presets',
    { preHandler: requireAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({ presets: [...BUILTIN_LAUNCHER_PRESETS] });
    },
  );

  app.get(
    '/api/projects/:id/pens',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      if (!id) return badRequest(reply, 'project id required');
      const pens = deps.getPens ? await deps.getPens(request.authUser!.id, id) : null;
      return reply.code(200).send({ pens });
    },
  );

  app.put(
    '/api/projects/:id/pens',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      const parsed = ProjectPensV1Schema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, 'invalid project Pens');
      if (parsed.data.projectId !== id) {
        return badRequest(reply, 'pens.projectId must match path id');
      }
      if (deps.putPens) await deps.putPens(request.authUser!.id, id, parsed.data);
      return reply.code(200).send({ pens: parsed.data });
    },
  );
}
