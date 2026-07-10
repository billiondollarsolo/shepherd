/**
 * Per-user shell APIs: fleet selection, launcher presets, project layout mirror.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FleetSelectionPayloadSchema,
  LauncherPresetsPayloadSchema,
  ProjectLayoutV1Schema,
  BUILTIN_LAUNCHER_PRESETS,
  mergePresetsWithBuiltins,
  type FleetSelectionPayload,
  type LauncherPreset,
  type ProjectLayoutV1,
} from '@flock/shared';
import { badRequest } from '../http/reply.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import type { FleetSelectionStore } from './fleet-selection.js';

export interface MeRouteDeps {
  auth: AuthGuardDeps;
  selection: FleetSelectionStore;
  /** Optional persistent preset map userId → presets */
  getPresets?: (userId: string) => Promise<LauncherPreset[]>;
  putPresets?: (userId: string, presets: LauncherPreset[]) => Promise<void>;
  getLayout?: (projectId: string) => Promise<ProjectLayoutV1 | null>;
  putLayout?: (projectId: string, layout: ProjectLayoutV1) => Promise<void>;
}

export function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/me/selection',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.authUser!.id;
      const selection = deps.selection.get(userId);
      return reply.code(200).send({ selection });
    },
  );

  app.put(
    '/api/me/selection',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = FleetSelectionPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'invalid fleet selection payload');
      }
      const userId = request.authUser!.id;
      const selection = deps.selection.put(userId, parsed.data);
      return reply.code(200).send({ selection });
    },
  );

  app.get(
    '/api/me/launcher-presets',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.authUser!.id;
      const user = deps.getPresets ? await deps.getPresets(userId) : [];
      const presets = mergePresetsWithBuiltins(user);
      return reply.code(200).send({ presets });
    },
  );

  app.put(
    '/api/me/launcher-presets',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LauncherPresetsPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'invalid launcher presets payload');
      }
      const userId = request.authUser!.id;
      if (deps.putPresets) await deps.putPresets(userId, parsed.data.presets);
      const presets = mergePresetsWithBuiltins(parsed.data.presets);
      return reply.code(200).send({ presets });
    },
  );

  // Builtins-only fallback when no put store
  app.get('/api/me/launcher-presets/builtins', { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(200).send({ presets: [...BUILTIN_LAUNCHER_PRESETS] }),
  );

  app.get(
    '/api/projects/:id/layout',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      if (!id) return badRequest(reply, 'project id required');
      const layout = deps.getLayout ? await deps.getLayout(id) : null;
      return reply.code(200).send({ layout });
    },
  );

  app.put(
    '/api/projects/:id/layout',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id;
      const parsed = ProjectLayoutV1Schema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'invalid project layout');
      }
      if (parsed.data.projectId !== id) {
        return badRequest(reply, 'layout.projectId must match path id');
      }
      if (deps.putLayout) await deps.putLayout(id, parsed.data);
      return reply.code(200).send({ layout: parsed.data });
    },
  );
}

export type { FleetSelectionPayload };
