/**
 * Project CRUD routes (spec §8.1, FR-N3, NFR-SEC6).
 *
 *   GET  /api/projects[?nodeId=...]   { projects: Project[] }
 *   POST /api/projects                body CreateProjectRequest → 201 { project }
 *
 * Cookie-authed via the shared `requireAuth` guard. Query/body are validated with
 * the shared zod contracts (`ListProjectsQuery`, `CreateProjectRequest`); an
 * unknown nodeId on create maps to 404. The response wraps the project as
 * `{ project }` to match the shared `ProjectResponse`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateProjectRequest, ListProjectsQuery } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { ProjectNodeNotFoundError, type ProjectService } from './project-service.js';

/**
 * Register the project routes against a {@link ProjectService}. Plain function so
 * `buildServer` wires it with the concrete service + auth guard.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { service: ProjectService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  // --- list projects -----------------------------------------------------
  app.get(
    '/api/projects',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListProjectsQuery.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(reply, 'nodeId, when provided, must be a valid id.');
      }
      const projects = await deps.service.listProjects(parsed.data.nodeId);
      return reply.code(200).send({ projects });
    },
  );

  // --- create project ----------------------------------------------------
  app.post(
    '/api/projects',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateProjectRequest.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'nodeId, name, and workingDir are required.');
      }
      try {
        const project = await deps.service.createProject(parsed.data);
        return reply.code(201).send({ project });
      } catch (err) {
        if (err instanceof ProjectNodeNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: 'node_not_found', message: err.message } });
        }
        throw err;
      }
    },
  );
}
