/**
 * Session diff route (US-33, spec §8.1, FR-UI4).
 *
 *   GET /api/sessions/:id/diff   read-only `git diff` of the session working dir
 *
 * Authed via the session cookie (NFR-SEC6): the `requireAuth` preHandler rejects
 * an unauthenticated caller with 401. The path param is validated with the shared
 * `SessionIdParams` zod contract (never duplicated). An unknown session maps to
 * 404 (spec §10); a git failure (e.g. the working dir is not a git repo) maps to
 * 422; the success body is the shared `DiffResponse`.
 *
 * READ-ONLY by design: v1 exposes the diff for viewing only — stage / commit /
 * PR are deferred to v1.x (spec §4.2). All diff logic lives in {@link DiffService};
 * this module is framework-thin (parse → call → map result/error to HTTP),
 * mirroring the terminate-route convention.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DiffQuery, SessionIdParams } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import {
  DiffSessionNotFoundError,
  DiffUnavailableError,
  type DiffService,
} from './diff-service.js';

/**
 * Register `GET /api/sessions/:id/diff`. Exposed as a plain function (not an
 * auto-loaded plugin) so `buildServer` wires it with the concrete service +
 * auth guard, and so tests can register it on an isolated Fastify app.
 */
export function registerDiffRoute(
  app: FastifyInstance,
  deps: { service: DiffService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/sessions/:id/diff',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SessionIdParams.safeParse(request.params);
      if (!parsed.success) {
        return badRequest(reply, 'a valid session id is required.');
      }

      // Optional `?staged=true|false` + `?path=` select which side / file to show
      // (the Source Control panel's per-file preview). Omitted → combined diff.
      const query = DiffQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return badRequest(reply, 'invalid diff query.');
      }
      const staged = query.data.staged === undefined ? undefined : query.data.staged === 'true';

      try {
        const result = await deps.service.getDiff(parsed.data.id, {
          staged,
          path: query.data.path,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof DiffSessionNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: 'session_not_found', message: err.message } });
        }
        if (err instanceof DiffUnavailableError) {
          // Send the concise detail (not the session-id-prefixed message).
          return reply.code(422).send({ error: { code: 'diff_unavailable', message: err.detail } });
        }
        throw err;
      }
    },
  );
}
