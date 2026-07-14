import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  SaveProjectPortRequest,
  StartProjectForwardRequest,
  UpdatePreviewRuntimeSettingsRequest,
  UpdateProjectPortRequest,
  Uuid,
} from '@flock/shared';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { badRequest } from '../http/reply.js';
import {
  ProjectNotFoundError,
  ProjectPortNotFoundError,
  type ProjectPortsService,
} from './project-ports-service.js';
import {
  PreviewDisabledError,
  PreviewForbiddenError,
  PreviewLimitError,
  PreviewServiceNotFoundError,
  PreviewUnavailableError,
  type PreviewService,
} from './service.js';

function ids(params: unknown): { projectId: string; serviceId?: string } | null {
  const value = params as { projectId?: unknown; serviceId?: unknown };
  const projectId = Uuid.safeParse(value.projectId);
  const serviceId = value.serviceId === undefined ? null : Uuid.safeParse(value.serviceId);
  if (!projectId.success || (serviceId && !serviceId.success)) return null;
  return { projectId: projectId.data, serviceId: serviceId?.data };
}

function sendError(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof ProjectNotFoundError) {
    void reply.code(404).send({ error: { code: 'project_not_found', message: error.message } });
  } else if (
    error instanceof ProjectPortNotFoundError ||
    error instanceof PreviewServiceNotFoundError
  ) {
    void reply.code(404).send({ error: { code: 'port_not_found', message: error.message } });
  } else if (error instanceof PreviewForbiddenError) {
    void reply.code(403).send({ error: { code: 'forbidden', message: error.message } });
  } else if (error instanceof PreviewDisabledError) {
    void reply.code(503).send({ error: { code: 'preview_disabled', message: error.message } });
  } else if (error instanceof PreviewUnavailableError) {
    void reply.code(422).send({ error: { code: 'listener_missing', message: error.message } });
  } else if (error instanceof PreviewLimitError) {
    void reply.code(429).send({ error: { code: 'pool_exhausted', message: error.message } });
  } else return false;
  return true;
}

export function registerProjectPortsRoutes(
  app: FastifyInstance,
  deps: { ports: ProjectPortsService; previews: PreviewService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get('/api/projects/:projectId/ports', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = ids(request.params);
    if (!parsed) return badRequest(reply, 'A valid project id is required.');
    try {
      return reply.code(200).send(await deps.ports.list(parsed.projectId, request.authUser!.id));
    } catch (error) {
      if (sendError(error, reply)) return;
      throw error;
    }
  });

  app.post(
    '/api/projects/:projectId/ports/refresh',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      if (!parsed) return badRequest(reply, 'A valid project id is required.');
      try {
        return reply
          .code(200)
          .send(await deps.ports.list(parsed.projectId, request.authUser!.id, true));
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.post(
    '/api/projects/:projectId/ports/activate',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      if (!parsed) return badRequest(reply, 'A valid project id is required.');
      try {
        await deps.ports.activateRemembered(parsed.projectId, {
          userId: request.authUser!.id,
          ip: request.ip ?? null,
        });
        return reply.code(204).send();
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.post(
    '/api/projects/:projectId/ports',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = SaveProjectPortRequest.safeParse(request.body);
      if (!parsed || !body.success)
        return badRequest(reply, 'A valid project service is required.');
      try {
        const port = await deps.ports.save(parsed.projectId, body.data, {
          userId: request.authUser!.id,
          ip: request.ip ?? null,
        });
        return reply.code(201).send({ port });
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.patch(
    '/api/projects/:projectId/ports/:serviceId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = UpdateProjectPortRequest.safeParse(request.body);
      if (!parsed?.serviceId || !body.success)
        return badRequest(reply, 'A valid project service update is required.');
      try {
        const port = await deps.ports.update(parsed.projectId, parsed.serviceId, body.data, {
          userId: request.authUser!.id,
          ip: request.ip ?? null,
        });
        return reply.code(200).send({ port });
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.delete(
    '/api/projects/:projectId/ports/:serviceId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      if (!parsed?.serviceId) return badRequest(reply, 'A valid project service is required.');
      try {
        await deps.ports.forget(parsed.projectId, parsed.serviceId, {
          userId: request.authUser!.id,
          ip: request.ip ?? null,
        });
        return reply.code(204).send();
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.post(
    '/api/projects/:projectId/ports/:serviceId/forward',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      const body = StartProjectForwardRequest.safeParse(request.body ?? {});
      if (!parsed?.serviceId || !body.success)
        return badRequest(reply, 'A valid forward request is required.');
      try {
        return reply.code(201).send(
          await deps.ports.start(parsed.projectId, parsed.serviceId, body.data.ttlMs, {
            userId: request.authUser!.id,
            ip: request.ip ?? null,
          }),
        );
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.delete(
    '/api/projects/:projectId/ports/:serviceId/forward',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      if (!parsed?.serviceId) return badRequest(reply, 'A valid forward is required.');
      try {
        await deps.ports.stop(parsed.projectId, parsed.serviceId, {
          userId: request.authUser!.id,
          ip: request.ip ?? null,
        });
        return reply.code(204).send();
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.post(
    '/api/projects/:projectId/ports/:serviceId/forward/relaunch',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ids(request.params);
      if (!parsed?.serviceId) return badRequest(reply, 'A valid forward is required.');
      try {
        return reply.code(200).send(
          await deps.ports.relaunch(parsed.projectId, parsed.serviceId, {
            userId: request.authUser!.id,
            ip: request.ip ?? null,
          }),
        );
      } catch (error) {
        if (sendError(error, reply)) return;
        throw error;
      }
    },
  );

  app.get('/api/settings/deployment-preview', { preHandler: requireAuth }, async (request, reply) =>
    reply.code(200).send(await deps.previews.deploymentSettings(request.authUser!.id)),
  );

  app.patch(
    '/api/settings/deployment-preview',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = UpdatePreviewRuntimeSettingsRequest.safeParse(request.body);
      if (!body.success)
        return badRequest(reply, 'At least one valid runtime Preview setting is required.');
      const runtime = await deps.previews.updateRuntimeSettings(
        request.authUser!.id,
        body.data,
        request.ip ?? null,
      );
      return reply.code(200).send({
        ...(await deps.previews.deploymentSettings(request.authUser!.id)),
        runtime,
      });
    },
  );

  app.post(
    '/api/settings/deployment-preview/test',
    { preHandler: requireAuth },
    async (request, reply) =>
      reply.code(200).send(
        await deps.previews.routingTest({
          userId: request.authUser!.id,
          ip: request.ip ?? null,
        }),
      ),
  );
}
