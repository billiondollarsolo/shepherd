import type { FastifyInstance } from 'fastify';
import { CreateSessionRequest, toPublicSession } from '@flock/shared';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import type { EventReadService } from '../events/index.js';
import type { NodeAgentdClient } from '../nodes/agentd/agentd-client.js';
import type { DrizzleSessionRegistry } from './drizzle-session-registry.js';
import type { SessionRestService } from './session-rest-service.js';

export interface CollaborationRouteDeps {
  auth: AuthGuardDeps;
  sessions: Pick<SessionRestService, 'createSession'>;
  registry: Pick<DrizzleSessionRegistry, 'getSession'>;
  events: Pick<EventReadService, 'recentChats'>;
  clientForNode: (nodeId: string) => NodeAgentdClient | null;
  seedDelayMs?: number;
}

function seedAgent(dependencies: CollaborationRouteDeps, sessionId: string, content: string): void {
  setTimeout(() => {
    void (async () => {
      const session = await dependencies.registry.getSession(sessionId).catch(() => null);
      const client = session ? dependencies.clientForNode(session.nodeId) : null;
      if (client) client.write(sessionId, Buffer.from(`${content}\r`));
    })();
  }, dependencies.seedDelayMs ?? 4_500);
}

/** Register human-triggered provider handoff and task-race routes. */
export function registerCollaborationRoutes(
  app: FastifyInstance,
  dependencies: CollaborationRouteDeps,
): void {
  const requireAuth = makeRequireAuth(dependencies.auth);

  app.post('/api/sessions/:id/handoff', { preHandler: requireAuth }, async (request, reply) => {
    const sourceId = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { agentType?: string };
    const source = await dependencies.registry.getSession(sourceId).catch(() => null);
    if (!source || source.closedAt != null) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'source session not found' } });
    }
    const parsed = CreateSessionRequest.safeParse({
      projectId: source.projectId,
      agentType: body.agentType,
      workingDir: source.workingDir,
    });
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'valid agentType is required' } });
    }
    const actor = request.authUser!;
    const created = await dependencies.sessions.createSession(parsed.data, {
      userId: actor.id,
      ip: request.ip ?? null,
    });
    const chats = await dependencies.events.recentChats(sourceId, 12).catch(() => []);
    const transcript = chats
      .map((chat) => `${chat.role}: ${chat.text}`)
      .join('\n')
      .slice(0, 6_000);
    const seed =
      `[Handoff from a ${source.agentType} agent — continue this work.]` +
      (transcript ? `\n\nRecent context:\n${transcript}` : '');
    seedAgent(dependencies, created.session.id, seed);
    return reply.code(201).send({ session: toPublicSession(created.session) });
  });

  app.post('/api/race', { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      projectId?: string;
      task?: string;
      agentTypes?: unknown;
    };
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    const types = Array.isArray(body.agentTypes)
      ? body.agentTypes.filter((value): value is string => typeof value === 'string')
      : [];
    if (!body.projectId || !task || types.length < 2) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'projectId, task, and 2+ agentTypes required' },
      });
    }
    const actor = request.authUser!;
    const context = { userId: actor.id, ip: request.ip ?? null };
    const sessionIds: string[] = [];
    for (const agentType of types) {
      const parsed = CreateSessionRequest.safeParse({ projectId: body.projectId, agentType });
      if (!parsed.success) continue;
      try {
        sessionIds.push(
          (await dependencies.sessions.createSession(parsed.data, context)).session.id,
        );
      } catch {
        // One unavailable agent does not prevent the remaining racers.
      }
    }
    const seed = `[Race task — work this independently.]\n\n${task}`;
    for (const id of sessionIds) seedAgent(dependencies, id, seed);
    return reply.code(201).send({ task, sessionIds });
  });
}
