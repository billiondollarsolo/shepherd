/**
 * Node filesystem browse route (path picker support).
 *
 *   GET /api/nodes/:id/fs?path=...   →   { path, parent, entries[] }
 *
 * Cookie-authed (NFR-SEC6) via `requireAuth`. The node id is validated with the
 * shared `Uuid`; the optional `path` with `ListNodeDirQuery`. An unreachable node
 * or unreadable path maps to 422 (the node exists but can't be listed); the
 * success body is the shared `ListNodeDirResponse`.
 *
 * Framework-thin (parse → call service → map result/error to HTTP), mirroring the
 * diff-route convention.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ListNodeDirQuery, NodeFileWriteRequest, NodeMakeDirRequest, Uuid } from '@flock/shared';
import { z } from 'zod';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAdmin, makeRequireAuth } from '../auth/middleware.js';
import { NodePathError, NodeUnreachableError, type NodeFsService } from './node-fs-service.js';

const NodeIdParams = z.object({ id: Uuid });

/** Register `GET /api/nodes/:id/fs`. Wired by buildServer with the concrete service. */
export function registerNodeFsRoute(
  app: FastifyInstance,
  deps: { service: NodeFsService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);
  // T8: writing arbitrary files on ANY node (incl. ones the user has no session on)
  // is code-execution-equivalent — gate the write endpoint to admins. Browse + read
  // stay member-accessible (the path picker + file viewer). Members still get a real
  // shell only on nodes where they own a session (their terminal), not via this API.
  const requireAdmin = makeRequireAdmin(deps.auth);

  app.get(
    '/api/nodes/:id/fs',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) {
        return badRequest(reply, 'a valid node id is required.');
      }
      const query = ListNodeDirQuery.safeParse(request.query);
      if (!query.success) {
        return badRequest(reply, 'path must be a string.');
      }

      try {
        const result = await deps.service.listDir(params.data.id, query.data.path);
        return reply.code(200).send(result);
      } catch (err) {
        return mapFsError(reply, err);
      }
    },
  );

  // File tree (dirs + files) for the VS Code–style browser.
  app.get(
    '/api/nodes/:id/fs/tree',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const query = ListNodeDirQuery.safeParse(request.query);
      if (!query.success) return badRequest(reply, 'path must be a string.');
      try {
        return reply.code(200).send(await deps.service.listTree(params.data.id, query.data.path));
      } catch (err) {
        return mapFsError(reply, err);
      }
    },
  );

  // Read a file's bytes (base64, capped) — the file viewer/editor.
  app.get(
    '/api/nodes/:id/fs/file',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const query = z.object({ path: z.string().min(1) }).safeParse(request.query);
      if (!query.success) return badRequest(reply, 'a file path is required.');
      try {
        return reply.code(200).send(await deps.service.readFile(params.data.id, query.data.path));
      } catch (err) {
        return mapFsError(reply, err);
      }
    },
  );

  // Write a file's bytes (base64) — editor save + drag-and-drop upload. ADMIN-only
  // (T8): arbitrary file write on any node = code execution.
  app.put(
    '/api/nodes/:id/fs/file',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const body = NodeFileWriteRequest.safeParse(request.body);
      if (!body.success) return badRequest(reply, 'path and contentBase64 are required.');
      try {
        await deps.service.writeFile(params.data.id, body.data.path, body.data.contentBase64);
        return reply.code(200).send({ ok: true, path: body.data.path });
      } catch (err) {
        return mapFsError(reply, err);
      }
    },
  );

  // Create a directory (path picker "New folder"). ADMIN-only (T8): like the file
  // write, a filesystem mutation on an arbitrary node is privileged.
  app.post(
    '/api/nodes/:id/fs/mkdir',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, 'a valid node id is required.');
      const body = NodeMakeDirRequest.safeParse(request.body);
      if (!body.success) {
        return badRequest(reply, 'parent and a valid folder name are required.');
      }
      try {
        const result = await deps.service.makeDir(params.data.id, body.data.parent, body.data.name);
        return reply.code(201).send(result);
      } catch (err) {
        return mapFsError(reply, err);
      }
    },
  );
}

/** Map fs-service errors to HTTP (422 for unreachable/unreadable), else rethrow. */
function mapFsError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NodeUnreachableError || err instanceof NodePathError) {
    return reply.code(422).send({ error: { code: 'fs_unavailable', message: err.message } });
  }
  throw err;
}
