/**
 * Session git source-control routes (US-33.1) — the WRITE side of the Diff
 * feature (the Codex review loop).
 *
 *   GET  /api/sessions/:id/git/status     file list + branch/ahead/behind
 *   POST /api/sessions/:id/git/stage      { paths } (empty → all)
 *   POST /api/sessions/:id/git/unstage    { paths } (empty → all)
 *   POST /api/sessions/:id/git/commit     { message }  (commits as the Flock user)
 *   POST /api/sessions/:id/git/push       (node's own remote credentials)
 *
 * All routes are cookie-authed (NFR-SEC6) via the shared `requireAuth`
 * preHandler, which also attaches `request.authUser` — used to inject the commit
 * identity so commits succeed even on a node with no git config. Framework-thin:
 * parse → call {@link GitService} → map result/error to HTTP, mirroring
 * diff-route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GitCommitRequest, GitStageRequest, SessionIdParams } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { DiffSessionNotFoundError } from './diff-service.js';
import { GitOperationError, type GitIdentity, type GitService } from './git-service.js';

/** Map a service error to its HTTP response; rethrow anything unexpected. */
function mapError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DiffSessionNotFoundError) {
    return reply.code(404).send({ error: { code: 'session_not_found', message: err.message } });
  }
  if (err instanceof GitOperationError) {
    return reply.code(422).send({ error: { code: 'git_unavailable', message: err.detail } });
  }
  throw err;
}

/** Parse + validate the `:id` path param, replying 400 on failure. */
function sessionId(request: FastifyRequest, reply: FastifyReply): string | null {
  const parsed = SessionIdParams.safeParse(request.params);
  if (!parsed.success) {
    badRequest(reply, 'a valid session id is required.');
    return null;
  }
  return parsed.data.id;
}

/** Derive a git author/committer identity from the acting Flock user. */
function identityFor(request: FastifyRequest): GitIdentity {
  const username = request.authUser?.username ?? 'flock';
  const email = username.includes('@') ? username : `${username}@flock.local`;
  return { name: username, email };
}

export function registerGitRoutes(
  app: FastifyInstance,
  deps: { service: GitService; auth: AuthGuardDeps },
): void {
  const requireAuth = makeRequireAuth(deps.auth);

  app.get(
    '/api/sessions/:id/git/status',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionId(request, reply);
      if (!id) return reply;
      try {
        return reply.code(200).send(await deps.service.status(id));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  app.post(
    '/api/sessions/:id/git/stage',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionId(request, reply);
      if (!id) return reply;
      const body = GitStageRequest.safeParse(request.body ?? {});
      if (!body.success) return badRequest(reply, 'paths must be an array of strings.');
      try {
        return reply.code(200).send(await deps.service.stage(id, body.data.paths));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  app.post(
    '/api/sessions/:id/git/unstage',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionId(request, reply);
      if (!id) return reply;
      const body = GitStageRequest.safeParse(request.body ?? {});
      if (!body.success) return badRequest(reply, 'paths must be an array of strings.');
      try {
        return reply.code(200).send(await deps.service.unstage(id, body.data.paths));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  app.post(
    '/api/sessions/:id/git/commit',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionId(request, reply);
      if (!id) return reply;
      const body = GitCommitRequest.safeParse(request.body ?? {});
      if (!body.success || body.data.message.trim().length === 0) {
        return badRequest(reply, 'a non-empty commit message is required.');
      }
      try {
        return reply
          .code(200)
          .send(await deps.service.commit(id, body.data.message.trim(), identityFor(request)));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  app.post(
    '/api/sessions/:id/git/push',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionId(request, reply);
      if (!id) return reply;
      try {
        return reply.code(200).send(await deps.service.push(id));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );
}
