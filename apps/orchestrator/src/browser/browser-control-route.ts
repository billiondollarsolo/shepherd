/**
 * Browser input-takeover routes (US-28, FR-B4).
 *
 *   POST /api/sessions/:id/browser/takeover   acquire the single input-control lock
 *   POST /api/sessions/:id/browser/release    release it
 *
 * Cookie-authed (NFR-SEC6): the acting user is the control's `controllerId`, so a
 * second user is rejected with 409 (single-controller). Framework-thin: parse →
 * call the channels service → map result/error to HTTP (mirrors diff-route).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SessionIdParams, type BrowserControlResponse } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { TakeoverConflictError } from './layerC/index.js';

/** The slice of BrowserChannels the routes need. */
export interface BrowserControlService {
  takeover(
    sessionId: string,
    controllerId: string,
    ip: string | null,
  ): Promise<BrowserControlResponse>;
  release(sessionId: string, controllerId: string): Promise<BrowserControlResponse>;
}

export function registerBrowserControlRoutes(
  app: FastifyInstance,
  deps: { service: BrowserControlService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.post(
    '/api/sessions/:id/browser/takeover',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParams.safeParse(request.params);
      if (!parsed.success) return badRequest(reply, 'a valid session id is required.');
      const actor = request.authUser!;
      try {
        const result = await deps.service.takeover(parsed.data.id, actor.id, request.ip ?? null);
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof TakeoverConflictError) {
          return reply
            .code(409)
            .send({ error: { code: 'takeover_conflict', message: err.message } });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/sessions/:id/browser/release',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParams.safeParse(request.params);
      if (!parsed.success) return badRequest(reply, 'a valid session id is required.');
      const actor = request.authUser!;
      const result = await deps.service.release(parsed.data.id, actor.id);
      return reply.code(200).send(result);
    },
  );
}
