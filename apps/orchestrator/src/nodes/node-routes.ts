/**
 * Node CRUD routes (spec §8.1, FR-N1/N2, NFR-SEC6).
 *
 *   GET    /api/nodes        { nodes: Node[] }
 *   POST   /api/nodes        body CreateNodeRequest → 201 { node: Node }
 *   DELETE /api/nodes/:id    → 204 (cascade), `node_remove` audit
 *
 * All routes are cookie-authed via the shared `requireAuth` guard (the global
 * default-deny surface guard already covers them; this is the per-route belt).
 * Bodies/params are validated with the shared zod contracts (never duplicated).
 * The created node is returned wrapped as `{ node }` to match the shared
 * `NodeResponse`; an SSH node never echoes its raw key (only `sshKeyRef`).
 *
 * Framework-thin: parse → call service → map result/error to HTTP, mirroring the
 * terminate-route convention.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateNodeRequest, UpdateNodeRequest, Uuid } from '@flock/shared';
import { z } from 'zod';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { type NodeService, NodeValidationError } from './node-service.js';

const NodeIdParams = z.object({ id: Uuid });

/**
 * Register the node CRUD routes against a {@link NodeService}. Exposed as a plain
 * function so `buildServer` wires it with the concrete service + auth guard and
 * tests can register it on an isolated Fastify app.
 */
export function registerNodeRoutes(
  app: FastifyInstance,
  deps: { service: NodeService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  // --- list nodes --------------------------------------------------------
  app.get('/api/nodes', { preHandler: requireAuth }, async (_request, reply) => {
    const nodes = await deps.service.listNodes();
    return reply.code(200).send({ nodes });
  });

  // --- create node -------------------------------------------------------
  app.post(
    '/api/nodes',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateNodeRequest.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          reply,
          'a valid node (name, kind, and ssh host/user/private key for ssh nodes) is required.',
        );
      }
      // requireAuth guarantees authUser is set (else it already replied 401).
      const actor = request.authUser!;
      const node = await deps.service.createNode(parsed.data, {
        userId: actor.id,
        ip: request.ip ?? null,
      });
      return reply.code(201).send({ node });
    },
  );

  // --- update node (edit) ------------------------------------------------
  app.patch(
    '/api/nodes/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = NodeIdParams.safeParse(request.params);
      if (!params.success) {
        return badRequest(reply, 'a valid node id is required.');
      }
      const parsed = UpdateNodeRequest.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, 'a valid node update is required.');
      }
      const actor = request.authUser!;
      try {
        const node = await deps.service.updateNode(params.data.id, parsed.data, {
          userId: actor.id,
          ip: request.ip ?? null,
        });
        if (!node) {
          return reply
            .code(404)
            .send({ error: { code: 'node_not_found', message: 'Node was not found.' } });
        }
        return reply.code(200).send({ node });
      } catch (err) {
        // A user-correctable problem (e.g. switching to password auth without a
        // password) is a 400, not a 500.
        if (err instanceof NodeValidationError) {
          return badRequest(reply, err.message);
        }
        throw err;
      }
    },
  );

  // --- delete node -------------------------------------------------------
  app.delete(
    '/api/nodes/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = NodeIdParams.safeParse(request.params);
      if (!parsed.success) {
        return badRequest(reply, 'a valid node id is required.');
      }
      const actor = request.authUser!;
      const removed = await deps.service.deleteNode(parsed.data.id, {
        userId: actor.id,
        ip: request.ip ?? null,
      });
      if (!removed) {
        return reply
          .code(404)
          .send({ error: { code: 'node_not_found', message: 'Node was not found.' } });
      }
      return reply.code(204).send();
    },
  );
}
