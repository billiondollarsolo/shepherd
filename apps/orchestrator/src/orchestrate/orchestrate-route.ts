/**
 * Agent-facing orchestration routes — authed by the caller's per-session HOOK
 * TOKEN (Bearer), NOT the user cookie, and scoped to the caller's project:
 *   GET /api/orchestrate/:callerId/agents              — sibling agents + status + msg
 *   GET /api/orchestrate/:callerId/wait/:targetId      — block until ?status= (or timeout)
 * The agent already has FLOCK_HOOK_URL (carries :callerId) + FLOCK_HOOK_TOKEN, so
 * it can call these with the same curl pattern it uses for hooks.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { OrchestrationError, type OrchestrationService } from './orchestrate-service.js';

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice('Bearer '.length) : '';
}

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof OrchestrationError) {
    const status = e.code === 'unauthorized' ? 401 : e.code === 'not_found' ? 404 : 400;
    return reply.code(status).send({ error: { code: e.code, message: e.message } });
  }
  return reply
    .code(500)
    .send({ error: { code: 'internal', message: 'orchestration request failed' } });
}

export function registerOrchestrateRoute(app: FastifyInstance, svc: OrchestrationService): void {
  app.get('/api/orchestrate/:callerId/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const { callerId } = req.params as { callerId: string };
    try {
      return reply.code(200).send({ agents: await svc.listAgents(callerId, bearer(req)) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get(
    '/api/orchestrate/:callerId/wait/:targetId',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId, targetId } = req.params as { callerId: string; targetId: string };
      const q = req.query as { status?: string; timeoutMs?: string };
      try {
        const out = await svc.wait(
          callerId,
          bearer(req),
          targetId,
          q.status ?? 'idle',
          Number(q.timeoutMs) || 30_000,
        );
        return reply.code(200).send(out);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // Launch a sibling agent in the caller's project (capped). Body: { agentType }.
  app.post('/api/orchestrate/:callerId/spawn', async (req: FastifyRequest, reply: FastifyReply) => {
    const { callerId } = req.params as { callerId: string };
    const body = (req.body ?? {}) as { agentType?: string };
    try {
      return reply.code(201).send(await svc.spawn(callerId, bearer(req), body.agentType ?? ''));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Deliver text (a task / reply) to a sibling agent. Body: { targetId, text }.
  app.post('/api/orchestrate/:callerId/send', async (req: FastifyRequest, reply: FastifyReply) => {
    const { callerId } = req.params as { callerId: string };
    const body = (req.body ?? {}) as { targetId?: string; text?: string };
    try {
      return reply
        .code(200)
        .send(await svc.send(callerId, bearer(req), body.targetId ?? '', body.text ?? ''));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Read a sibling's recent output. GET .../read/:targetId?limit=
  app.get(
    '/api/orchestrate/:callerId/read/:targetId',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId, targetId } = req.params as { callerId: string; targetId: string };
      const q = req.query as { limit?: string };
      try {
        return reply
          .code(200)
          .send(await svc.readOutput(callerId, bearer(req), targetId, Number(q.limit) || 10));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // Terminate a sibling agent. Body: { targetId }.
  app.post('/api/orchestrate/:callerId/kill', async (req: FastifyRequest, reply: FastifyReply) => {
    const { callerId } = req.params as { callerId: string };
    const body = (req.body ?? {}) as { targetId?: string };
    try {
      return reply.code(200).send(await svc.kill(callerId, bearer(req), body.targetId ?? ''));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Restart a sibling (kill + respawn same type). Body: { targetId }.
  app.post(
    '/api/orchestrate/:callerId/restart',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId } = req.params as { callerId: string };
      const body = (req.body ?? {}) as { targetId?: string };
      try {
        return reply.code(201).send(await svc.restart(callerId, bearer(req), body.targetId ?? ''));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
