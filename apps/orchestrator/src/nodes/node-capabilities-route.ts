import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ConfigureNodeDockerRequestSchema,
  InstallNodeToolRequestSchema,
  Uuid,
  type ConfigureNodeDockerResponse,
  type InstallNodeToolResponse,
  type NodeCapabilitiesResponse,
} from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { NodeCapabilityOperationError } from './node-capabilities.js';

interface ActionContext {
  userId: string;
  ip: string | null;
}

export interface NodeCapabilitiesRouteDeps {
  auth: AuthGuardDeps;
  inspect(nodeId: string): Promise<NodeCapabilitiesResponse | null>;
  installTool(
    nodeId: string,
    tool: InstallNodeToolResponse['tool'],
    context: ActionContext,
  ): Promise<InstallNodeToolResponse | null>;
  configureDocker(
    nodeId: string,
    action: ConfigureNodeDockerResponse['action'],
    context: ActionContext,
  ): Promise<ConfigureNodeDockerResponse | null>;
}

function sendOperationError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof NodeCapabilityOperationError)) throw error;
  const statusCode =
    error.code === 'node_unavailable' ? 503 : error.code === 'operation_in_progress' ? 409 : 422;
  return reply.code(statusCode).send({ error: { code: error.code, message: error.message } });
}

export function registerNodeCapabilitiesRoutes(
  app: FastifyInstance,
  deps: NodeCapabilitiesRouteDeps,
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get('/api/nodes/:id/capabilities', { preHandler: requireAuth }, async (request, reply) => {
    const id = Uuid.safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'invalid node id' } });
    }
    try {
      const result = await deps.inspect(id.data);
      return result
        ? reply.code(200).send(result)
        : reply.code(503).send({
            error: { code: 'node_unavailable', message: 'Node capabilities are unavailable.' },
          });
    } catch (error) {
      return sendOperationError(error, reply);
    }
  });

  app.post('/api/nodes/:id/tools/install', { preHandler: requireAuth }, async (request, reply) => {
    const id = Uuid.safeParse((request.params as { id?: string }).id);
    const body = InstallNodeToolRequestSchema.safeParse(request.body);
    if (!id.success || !body.success) {
      return reply.code(400).send({
        error: {
          code: 'confirmation_required',
          message: 'A valid tool and confirm="INSTALL" are required.',
        },
      });
    }
    try {
      const result = await deps.installTool(id.data, body.data.tool, {
        userId: request.authUser!.id,
        ip: request.ip ?? null,
      });
      return result
        ? reply.code(200).send(result)
        : reply.code(404).send({ error: { code: 'not_found', message: 'Node not found.' } });
    } catch (error) {
      return sendOperationError(error, reply);
    }
  });

  app.post('/api/nodes/:id/docker', { preHandler: requireAuth }, async (request, reply) => {
    const id = Uuid.safeParse((request.params as { id?: string }).id);
    const body = ConfigureNodeDockerRequestSchema.safeParse(request.body);
    if (!id.success || !body.success) {
      return reply.code(400).send({
        error: {
          code: 'confirmation_required',
          message: 'A valid Docker action and root-equivalent confirmation are required.',
        },
      });
    }
    try {
      const result = await deps.configureDocker(id.data, body.data.action, {
        userId: request.authUser!.id,
        ip: request.ip ?? null,
      });
      return result
        ? reply.code(200).send(result)
        : reply.code(404).send({ error: { code: 'not_found', message: 'Node not found.' } });
    } catch (error) {
      return sendOperationError(error, reply);
    }
  });
}
