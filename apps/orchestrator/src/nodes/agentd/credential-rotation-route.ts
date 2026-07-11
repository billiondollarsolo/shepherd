import type { FastifyInstance } from 'fastify';

import { Uuid } from '@flock/shared';

import type { AuthGuardDeps } from '../../auth/middleware.js';
import { makeRequireAuth } from '../../auth/middleware.js';

export type NodeCredentialRotationResult = 'rotated' | 'not_found' | 'unavailable';

export function registerNodeCredentialRotationRoute(
  app: FastifyInstance,
  deps: {
    auth: AuthGuardDeps;
    rotate: (
      nodeId: string,
      context: { userId: string; ip: string | null },
    ) => Promise<NodeCredentialRotationResult>;
  },
): void {
  app.post(
    '/api/nodes/:id/rotate-control-credential',
    { preHandler: makeRequireAuth(deps.auth) },
    async (request, reply) => {
      const parsedId = Uuid.safeParse((request.params as { id?: string }).id);
      if (!parsedId.success) {
        return reply.code(400).send({ error: { code: 'bad_request', message: 'invalid node id' } });
      }
      const result = await deps.rotate(parsedId.data, {
        userId: request.authUser!.id,
        ip: request.ip ?? null,
      });
      if (result === 'not_found') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'node not found' } });
      }
      if (result === 'unavailable') {
        return reply
          .code(409)
          .send({ error: { code: 'node_unavailable', message: 'node control link unavailable' } });
      }
      return reply.code(200).send({ nodeId: parsedId.data, rotated: true });
    },
  );
}
