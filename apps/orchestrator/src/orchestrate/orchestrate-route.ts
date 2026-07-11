/**
 * Agent-facing orchestration routes — authed by a separate scoped capability
 * (Bearer), NOT the callback token or user cookie, and bound to one project:
 *   GET /api/orchestrate/:callerId/agents              — sibling agents + status + msg
 *   GET /api/orchestrate/:callerId/wait/:targetId      — block until ?status= (or timeout)
 * The agent uses FLOCK_HOOK_URL only to derive its origin/caller id and presents
 * FLOCK_ORCHESTRATE_TOKEN when the operator explicitly delegated scopes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  RequestBudget,
  makeRejectionReporter,
  withinRequestBudget,
} from '../http/request-budget.js';
import { OrchestrationError, type OrchestrationService } from './orchestrate-service.js';

export interface OrchestrationAbuseControls {
  read: RequestBudget;
  send: RequestBudget;
  destructive: RequestBudget;
  wait: RequestBudget;
}

const SMALL_COMMAND_BODY_LIMIT = 8 * 1024;
const SEND_BODY_LIMIT = 64 * 1024;

function defaultAbuseControls(): OrchestrationAbuseControls {
  return {
    read: new RequestBudget({
      maxRequests: 240,
      windowMs: 60_000,
      maxConcurrent: 128,
      maxConcurrentPerKey: 8,
      onReject: makeRejectionReporter('orchestrate-read'),
    }),
    send: new RequestBudget({
      maxRequests: 120,
      windowMs: 60_000,
      maxConcurrent: 64,
      maxConcurrentPerKey: 4,
      onReject: makeRejectionReporter('orchestrate-send'),
    }),
    destructive: new RequestBudget({
      maxRequests: 20,
      windowMs: 60_000,
      maxConcurrent: 32,
      maxConcurrentPerKey: 2,
      onReject: makeRejectionReporter('orchestrate-destructive'),
    }),
    wait: new RequestBudget({
      maxRequests: 30,
      windowMs: 60_000,
      maxConcurrent: 64,
      maxConcurrentPerKey: 2,
      onReject: makeRejectionReporter('orchestrate-wait'),
    }),
  };
}

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice('Bearer '.length) : '';
}

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof OrchestrationError) {
    const status =
      e.code === 'unauthorized'
        ? 401
        : e.code === 'not_found'
          ? 404
          : e.code === 'rate_limited'
            ? 429
            : 400;
    if (status === 429) {
      void reply.header(
        'retry-after',
        String(Math.max(1, Math.ceil((e.retryAfterMs ?? 1_000) / 1_000))),
      );
    }
    return reply.code(status).send({
      error: { code: status === 429 ? 'too_many_requests' : e.code, message: e.message },
    });
  }
  return reply
    .code(500)
    .send({ error: { code: 'internal', message: 'orchestration request failed' } });
}

export function registerOrchestrateRoute(
  app: FastifyInstance,
  svc: OrchestrationService,
  abuse: OrchestrationAbuseControls = defaultAbuseControls(),
): void {
  app.get('/api/orchestrate/:callerId/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const { callerId } = req.params as { callerId: string };
    return withinRequestBudget(reply, abuse.read, callerId, async () => {
      try {
        return reply.code(200).send({ agents: await svc.listAgents(callerId, bearer(req)) });
      } catch (e) {
        return fail(reply, e);
      }
    });
  });

  app.get(
    '/api/orchestrate/:callerId/wait/:targetId',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId, targetId } = req.params as { callerId: string; targetId: string };
      const q = req.query as { status?: string; timeoutMs?: string };
      return withinRequestBudget(reply, abuse.wait, callerId, async () => {
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
      });
    },
  );

  // Launch a sibling agent in the caller's project (capped). Body: { agentType }.
  app.post(
    '/api/orchestrate/:callerId/spawn',
    { bodyLimit: SMALL_COMMAND_BODY_LIMIT },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId } = req.params as { callerId: string };
      const body = (req.body ?? {}) as { agentType?: string };
      return withinRequestBudget(reply, abuse.destructive, callerId, async () => {
        try {
          return reply.code(201).send(await svc.spawn(callerId, bearer(req), body.agentType ?? ''));
        } catch (e) {
          return fail(reply, e);
        }
      });
    },
  );

  // Deliver text (a task / reply) to a sibling agent. Body: { targetId, text }.
  app.post(
    '/api/orchestrate/:callerId/send',
    { bodyLimit: SEND_BODY_LIMIT },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId } = req.params as { callerId: string };
      const body = (req.body ?? {}) as { targetId?: string; text?: string };
      return withinRequestBudget(reply, abuse.send, callerId, async () => {
        try {
          return reply
            .code(200)
            .send(await svc.send(callerId, bearer(req), body.targetId ?? '', body.text ?? ''));
        } catch (e) {
          return fail(reply, e);
        }
      });
    },
  );

  // Read a sibling's recent output. GET .../read/:targetId?limit=
  app.get(
    '/api/orchestrate/:callerId/read/:targetId',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId, targetId } = req.params as { callerId: string; targetId: string };
      const q = req.query as { limit?: string };
      return withinRequestBudget(reply, abuse.read, callerId, async () => {
        try {
          return reply
            .code(200)
            .send(await svc.readOutput(callerId, bearer(req), targetId, Number(q.limit) || 10));
        } catch (e) {
          return fail(reply, e);
        }
      });
    },
  );

  // Terminate a sibling agent. Body: { targetId }.
  app.post(
    '/api/orchestrate/:callerId/kill',
    { bodyLimit: SMALL_COMMAND_BODY_LIMIT },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId } = req.params as { callerId: string };
      const body = (req.body ?? {}) as { targetId?: string };
      return withinRequestBudget(reply, abuse.destructive, callerId, async () => {
        try {
          return reply.code(200).send(await svc.kill(callerId, bearer(req), body.targetId ?? ''));
        } catch (e) {
          return fail(reply, e);
        }
      });
    },
  );

  // Restart a sibling (kill + respawn same type). Body: { targetId }.
  app.post(
    '/api/orchestrate/:callerId/restart',
    { bodyLimit: SMALL_COMMAND_BODY_LIMIT },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { callerId } = req.params as { callerId: string };
      const body = (req.body ?? {}) as { targetId?: string };
      return withinRequestBudget(reply, abuse.destructive, callerId, async () => {
        try {
          return reply
            .code(201)
            .send(await svc.restart(callerId, bearer(req), body.targetId ?? ''));
        } catch (e) {
          return fail(reply, e);
        }
      });
    },
  );
}
