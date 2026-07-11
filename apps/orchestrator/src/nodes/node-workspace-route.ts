/**
 * Node workspace routes — stack detection, fuzzy file list, Find-in-Files.
 *
 *   GET  /api/nodes/:id/stack?path=...                 → { path, stacks[] }
 *   GET  /api/nodes/:id/files?path=...&cap=N           → { files[] }
 *   POST /api/nodes/:id/search { path, query, ... }    → { matches[], truncated }
 *
 * Cookie-authed (NFR-SEC6). Unreachable node / unreadable path → 422. Thin:
 * parse → service → map (mirrors node-fs-route).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Uuid } from '@flock/shared';
import { z } from 'zod';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { NodePathError, NodeUnreachableError } from './node-fs-service.js';
import type { NodeWorkspaceService } from './node-workspace-service.js';

const NodeIdParams = z.object({ id: Uuid });
const PathQuery = z.object({ path: z.string().min(1) });
const FilesQuery = z.object({
  path: z.string().min(1),
  cap: z.coerce.number().int().positive().max(20000).optional(),
});
const SearchBody = z.object({
  path: z.string().min(1),
  query: z.string().min(1).max(500),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
});

export function registerNodeWorkspaceRoutes(
  app: FastifyInstance,
  deps: { service: NodeWorkspaceService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/nodes/:id/stack',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const query = PathQuery.safeParse(request.query);
      if (!query.success) return badRequest(reply, 'a path is required.');
      try {
        return reply
          .code(200)
          .send(await deps.service.detectStack(params.data.id, query.data.path));
      } catch (err) {
        return mapErr(reply, err);
      }
    },
  );

  app.get(
    '/api/nodes/:id/files',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const query = FilesQuery.safeParse(request.query);
      if (!query.success) return badRequest(reply, 'a path is required.');
      try {
        const files = await deps.service.listFiles(params.data.id, query.data.path, query.data.cap);
        return reply.code(200).send({ files });
      } catch (err) {
        return mapErr(reply, err);
      }
    },
  );

  app.post(
    '/api/nodes/:id/search',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const body = SearchBody.safeParse(request.body);
      if (!body.success) return badRequest(reply, 'path and query are required.');
      try {
        const result = await deps.service.search(params.data.id, body.data.path, body.data.query, {
          caseSensitive: body.data.caseSensitive,
          wholeWord: body.data.wholeWord,
          regex: body.data.regex,
        });
        return reply.code(200).send(result);
      } catch (err) {
        return mapErr(reply, err);
      }
    },
  );
}

function mapErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NodeUnreachableError || err instanceof NodePathError) {
    return reply.code(422).send({ error: { code: 'workspace_unavailable', message: err.message } });
  }
  throw err;
}
