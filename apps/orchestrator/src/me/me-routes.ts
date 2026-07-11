/** Built-in launcher presets and durable project Pen APIs. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PutProjectPensRequestSchema,
  PutUserPreferencesRequest,
  BUILTIN_LAUNCHER_PRESETS,
} from '@flock/shared';
import { badRequest } from '../http/reply.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import {
  UserPreferencesConflictError,
  type UserPreferencesService,
} from './user-preferences-service.js';
import { ProjectPensConflictError, type ProjectPensService } from './project-pens-service.js';

export interface MeRouteDeps {
  auth: AuthGuardDeps;
  pens?: Pick<ProjectPensService, 'get' | 'put'>;
  preferences?: UserPreferencesService;
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
    '/api/me/preferences',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const preferences = deps.preferences
        ? await deps.preferences.get(request.authUser!.id)
        : null;
      if (!preferences) {
        return reply.code(503).send({
          error: { code: 'preferences_unavailable', message: 'Preferences are unavailable.' },
        });
      }
      return reply.code(200).send({ preferences });
    },
  );

  app.put(
    '/api/me/preferences',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = PutUserPreferencesRequest.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, 'invalid preferences document');
      if (!deps.preferences) {
        return reply.code(503).send({
          error: { code: 'preferences_unavailable', message: 'Preferences are unavailable.' },
        });
      }
      try {
        const preferences = await deps.preferences.put(
          request.authUser!.id,
          parsed.data.baseRevision,
          parsed.data.preferences,
        );
        return reply.code(200).send({ preferences });
      } catch (error) {
        if (error instanceof UserPreferencesConflictError) {
          return reply.code(409).send({
            error: {
              code: 'preferences_conflict',
              message: error.message,
              details: { preferences: error.current },
            },
          });
        }
        throw error;
      }
    },
  );

  app.get(
    '/api/projects/:id/pens',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      if (!id) return badRequest(reply, 'project id required');
      const result = deps.pens
        ? await deps.pens.get(request.authUser!.id, id)
        : { pens: null, revision: 0 };
      return reply.code(200).send(result);
    },
  );

  app.put(
    '/api/projects/:id/pens',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      const parsed = PutProjectPensRequestSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, 'invalid project Pens');
      if (parsed.data.pens.projectId !== id) {
        return badRequest(reply, 'pens.projectId must match path id');
      }
      if (!deps.pens) {
        return reply.code(503).send({
          error: { code: 'pens_unavailable', message: 'Pens are unavailable.' },
        });
      }
      try {
        const result = await deps.pens.put(
          request.authUser!.id,
          id,
          parsed.data.baseRevision,
          parsed.data.pens,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof ProjectPensConflictError) {
          return reply.code(409).send({
            error: {
              code: 'pens_conflict',
              message: error.message,
              details: error.current,
            },
          });
        }
        throw error;
      }
    },
  );
}
