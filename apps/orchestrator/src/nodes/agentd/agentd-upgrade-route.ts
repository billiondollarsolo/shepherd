import type { FastifyInstance } from 'fastify';
import { Uuid } from '@flock/shared';

import type { AuthGuardDeps } from '../../auth/middleware.js';
import { makeRequireAuth } from '../../auth/middleware.js';

export type NodeAgentdUpgradeResult =
  | { status: 'upgraded' }
  | { status: 'active_sessions'; count: number }
  | { status: 'not_found' | 'not_remote' | 'unavailable' };

export function registerNodeAgentdUpgradeRoute(
  app: FastifyInstance,
  deps: {
    auth: AuthGuardDeps;
    upgrade: (
      nodeId: string,
      context: { userId: string; ip: string | null },
    ) => Promise<NodeAgentdUpgradeResult>;
  },
): void {
  app.post(
    '/api/nodes/:id/upgrade-agentd',
    { preHandler: makeRequireAuth(deps.auth) },
    async (request, reply) => {
      const id = Uuid.safeParse((request.params as { id?: string }).id);
      const confirm = (request.body as { confirm?: unknown } | null)?.confirm;
      if (!id.success || confirm !== 'UPGRADE') {
        return reply.code(400).send({
          error: {
            code: 'confirmation_required',
            message: 'A valid node id and confirm="UPGRADE" are required.',
          },
        });
      }
      const result = await deps.upgrade(id.data, {
        userId: request.authUser!.id,
        ip: request.ip ?? null,
      });
      if (result.status === 'upgraded') {
        return reply.code(200).send({ nodeId: id.data, upgraded: true });
      }
      if (result.status === 'active_sessions') {
        return reply.code(409).send({
          error: {
            code: 'active_sessions',
            message: `Finish the node's ${result.count} active session(s) before upgrading.`,
            details: { count: result.count },
          },
        });
      }
      const statusCode = result.status === 'not_found' ? 404 : 409;
      return reply.code(statusCode).send({
        error: {
          code: result.status,
          message:
            result.status === 'not_remote'
              ? 'The local daemon is upgraded with the Shepherd image.'
              : result.status === 'not_found'
                ? 'Node not found.'
                : 'The remote node is unavailable.',
        },
      });
    },
  );
}
