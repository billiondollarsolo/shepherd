/**
 * US-15 — POST /api/hooks/:sessionId route (spec §8.1, §15; NFR-SEC3).
 *
 *   POST /api/hooks/:sessionId   per-session-token-authed hook callback.
 *
 * This is the ONE endpoint authed by the per-session token in the
 * `Authorization` header, NOT the session cookie (spec §8.1 line 187). It is
 * the hot path that must stay DB-free (spec §15): all logic lives in
 * {@link HookEndpointService}, which resolves the session from the in-memory
 * live binding and enqueues the event write off the live path.
 *
 * This module is framework-thin: parse the path param with the shared
 * `SessionIdParams` contract, pull the token from the Authorization header,
 * call the service, and map its result/errors to HTTP:
 *   - success            → 202 + shared `HookCallbackResponse` ({ ok: true });
 *   - missing/invalid    → 401 (HookUnauthorizedError);
 *   - unknown/closed     → 404 (HookSessionNotFoundError, spec §10);
 *   - malformed id       → 400.
 *
 * Crucially, NO `requireAuth` cookie preHandler is attached: a session cookie
 * never authorizes this route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SessionIdParams } from '@flock/shared';
import { badRequest } from '../http/reply.js';
import {
  RequestBudget,
  makeRejectionReporter,
  withinRequestBudget,
} from '../http/request-budget.js';

import {
  HookSessionNotFoundError,
  HookUnauthorizedError,
  extractBearerToken,
  type HandleHookInput,
  type HookCallbackAck,
} from './endpoint.js';

/** The structural service surface the route depends on (fakeable in tests). */
export interface HookRouteService {
  handle(input: HandleHookInput): Promise<HookCallbackAck>;
}

export interface HookAbuseControls {
  perIp: RequestBudget;
  perSession: RequestBudget;
}

const HOOK_BODY_LIMIT = 256 * 1024;

export function createHookAbuseControls(): HookAbuseControls {
  return {
    perIp: new RequestBudget({
      maxRequests: 1_200,
      windowMs: 60_000,
      maxConcurrent: 128,
      maxConcurrentPerKey: 32,
      onReject: makeRejectionReporter('hooks-ip'),
    }),
    perSession: new RequestBudget({
      maxRequests: 600,
      windowMs: 60_000,
      maxConcurrent: 128,
      maxConcurrentPerKey: 8,
      onReject: makeRejectionReporter('hooks-session'),
    }),
  };
}

function unauthorized(reply: FastifyReply, message: string): void {
  void reply.code(401).send({ error: { code: 'unauthorized', message } });
}

/**
 * Register `POST /api/hooks/:sessionId`. Exposed as a plain function (not an
 * auto-loaded plugin) so `buildServer` wires the concrete service, and so tests
 * can register it on an isolated Fastify app. Deliberately has no cookie guard.
 */
export function registerHookRoute(
  app: FastifyInstance,
  deps: { service: HookRouteService; abuse?: HookAbuseControls },
): void {
  const abuse = deps.abuse ?? createHookAbuseControls();
  app.post(
    '/api/hooks/:sessionId',
    { bodyLimit: HOOK_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) =>
      withinRequestBudget(reply, abuse.perIp, request.ip, async () => {
        // The path param uses `:sessionId`; the shared contract validates `id`.
        const params = request.params as { sessionId?: string };
        const parsed = SessionIdParams.safeParse({ id: params.sessionId });
        if (!parsed.success) {
          return badRequest(reply, 'a valid session id is required.');
        }

        return withinRequestBudget(reply, abuse.perSession, parsed.data.id, async () => {
          // Per-session token auth (NFR-SEC3): a MISSING Authorization token is
          // rejected at the edge with 401 — no work is done for an unauthenticated
          // caller, and a session cookie never authorizes this route (spec §8.1).
          const token = extractBearerToken(request.headers.authorization);
          if (token === null) {
            return unauthorized(reply, 'Hook token is required.');
          }

          try {
            const ack = await deps.service.handle({
              sessionId: parsed.data.id,
              token,
              body: request.body,
            });
            // Fast 202 ack: accepted for async processing; never returns derived
            // status (spec §8.1 — the endpoint acks, the WS fans out the status).
            return reply.code(202).send(ack);
          } catch (err) {
            if (err instanceof HookUnauthorizedError) {
              return unauthorized(reply, err.message);
            }
            if (err instanceof HookSessionNotFoundError) {
              return reply
                .code(404)
                .send({ error: { code: 'session_not_found', message: err.message } });
            }
            throw err;
          }
        });
      }),
  );
}
